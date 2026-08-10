'use strict';

// OTLP span export (ADR-0026).
//
// nubos-pilot already records per-spawn metrics as flat JSONL under
// .nubos-pilot/metrics/. Flat is the wrong shape for the question operators
// actually ask — "which slice was expensive, and which agent inside it" — because
// the milestone → slice → task → agent-spawn hierarchy is a tree and the JSONL
// throws the edges away. That tree is already a span tree; nothing needed
// inventing, only mapping.
//
// What this deliberately is NOT: a Langfuse client. ADR-0001 forbids a daemon and
// ADR-0002 forbids runtime dependencies, and an observability platform brings
// both (ClickHouse, a collector, an SDK). So this emits the *wire format* —
// OTLP/HTTP with a JSON body, which is one POST built from node:https — and lets
// the operator point it at Langfuse, a collector, or anything else that speaks
// OTLP. Off by default; enabling it is a config edit, and with it off nothing in
// this file runs.
//
// Two properties worth stating because they are easy to get wrong:
//
//   * IDs are derived, not random. A span's id is a hash of its stable
//     identifier (project + milestone/slice/task/spawn key), so re-exporting the
//     same milestone produces the same ids and the backend updates one trace
//     instead of accumulating duplicates. Math.random would make every export a
//     new trace.
//   * A span with no observed time is omitted, never fabricated. Structural
//     spans (milestone, slice, task) have no clock of their own; they inherit
//     min(start)/max(end) from timed descendants. A slice whose tasks never ran
//     has no honest interval, and inventing `now` for it would make an unrun
//     slice indistinguishable from an instant one.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { NubosPilotError } = require('./core.cjs');

// OTLP JSON maps uint64 to string and bytes to hex, so ids are hex strings of a
// fixed width: 16 bytes for a trace, 8 for a span.
const TRACE_ID_HEX = 32;
const SPAN_ID_HEX = 16;

// SpanKind.INTERNAL — every span here is work inside this process tree, not an
// RPC boundary.
const SPAN_KIND_INTERNAL = 1;

const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const DEFAULT_SERVICE_NAME = 'nubos-pilot';
const DEFAULT_TIMEOUT_MS = 10000;
const SCOPE_NAME = 'nubos-pilot';

// A task/agent status that means the work failed. Anything else is either
// success or in-flight, and in-flight is UNSET rather than OK — claiming OK for
// something still running is the kind of small lie a dashboard amplifies.
const FAILED_STATUSES = Object.freeze(['failed', 'error', 'red', 'blocked']);
const OK_STATUSES = Object.freeze(['ok', 'success', 'done', 'verified', 'green', 'completed']);

function _err(code, message, details) {
  return new NubosPilotError(code, message, details || {});
}

/**
 * Deterministic id derivation. `width` is the hex width, so the same key always
 * yields the same id and a re-export updates rather than duplicates.
 *
 * An all-zero id is invalid in OTLP (it means "no span"), so a hash that
 * degenerates to zeros is nudged rather than emitted — astronomically unlikely,
 * but a zero id would be silently dropped by the collector instead of erroring.
 */
function deriveId(key, width) {
  const hex = crypto.createHash('sha256').update(String(key), 'utf-8').digest('hex').slice(0, width);
  return /^0+$/.test(hex) ? hex.slice(0, width - 1) + '1' : hex;
}

function traceIdFor(projectId, milestoneId) {
  // One trace per milestone. A whole project in one trace would be a span tree
  // spanning weeks, which every backend renders unusably.
  return deriveId('nubos-pilot/trace/' + projectId + '/' + (milestoneId || 'project'), TRACE_ID_HEX);
}

function spanIdFor(projectId, key) {
  return deriveId('nubos-pilot/span/' + projectId + '/' + key, SPAN_ID_HEX);
}

/**
 * ISO-8601 to Unix nanoseconds as a decimal string.
 * Returns null for anything unparseable, so callers can distinguish "no time"
 * from "time zero" — epoch 0 is a real instant and would plot in 1970.
 */
function toUnixNano(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Milliseconds are the resolution we actually have; multiply exactly rather
  // than pretending to nanosecond precision. BigInt avoids the 2^53 ceiling.
  return (BigInt(ms) * 1000000n).toString();
}

function _attr(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

/**
 * Build the OTLP attribute list, dropping null/undefined entries so an absent
 * value is absent rather than the string "null".
 */
function attributes(map) {
  const out = [];
  for (const key of Object.keys(map || {})) {
    const a = _attr(key, map[key]);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Infer gen_ai.system from a resolved model id, and only when the prefix is
 * unambiguous. The convention wants the GenAI product; guessing it wrong is
 * worse than omitting it, because a dashboard will group by it.
 */
function inferGenAiSystem(resolvedModel) {
  const m = String(resolvedModel || '').toLowerCase();
  if (!m) return null;
  if (m.includes('claude') || m.startsWith('anthropic')) return 'anthropic';
  if (/^(gpt-|o[134]-|text-davinci)/.test(m) || m.startsWith('openai')) return 'openai';
  if (m.includes('gemini') || m.startsWith('google')) return 'gcp.gemini';
  return null;
}

function _statusCode(status) {
  const s = String(status || '').toLowerCase();
  if (FAILED_STATUSES.includes(s)) return STATUS_ERROR;
  if (OK_STATUSES.includes(s)) return STATUS_OK;
  return STATUS_UNSET;
}

function _span({ traceId, spanId, parentSpanId, name, startNano, endNano, attrs, status, error }) {
  const span = {
    traceId,
    spanId,
    name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNano,
    // A zero-length span is legal and is what an instantaneous record looks like.
    endTimeUnixNano: endNano || startNano,
    attributes: attributes(attrs || {}),
    status: { code: status },
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (status === STATUS_ERROR && error && error.message) {
    span.status.message = String(error.message).slice(0, 300);
  }
  return span;
}

function _minNano(a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) <= BigInt(b) ? a : b;
}

function _maxNano(a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

/**
 * Map one metrics record to an agent-spawn span.
 * Returns null when the record carries no usable interval — the honest outcome
 * for a record whose timestamps are missing or malformed.
 */
function spawnSpan(record, ctx) {
  const rec = record || {};
  const startNano = toUnixNano(rec.started_at);
  if (!startNano) return null;
  const endNano = toUnixNano(rec.ended_at) || startNano;

  const taskKey = rec.task || rec.plan || rec.phase || 'unscoped';
  // run_id disambiguates retries of the same agent on the same task; without it
  // two spawns would collapse onto one span id and the second would overwrite
  // the first in the backend.
  const key = 'spawn/' + taskKey + '/' + (rec.agent || 'unknown')
    + '/' + (rec.run_id || rec.started_at);

  return _span({
    traceId: ctx.traceId,
    spanId: spanIdFor(ctx.projectId, key),
    parentSpanId: ctx.parentSpanId,
    name: rec.agent ? 'agent ' + rec.agent : 'agent spawn',
    startNano,
    endNano,
    status: _statusCode(rec.status),
    error: rec.error,
    attrs: {
      // OpenTelemetry GenAI semantic conventions — the reason a generic OTLP
      // backend can render this without knowing what nubos-pilot is.
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': rec.agent || null,
      'gen_ai.request.model': rec.resolved_model || null,
      'gen_ai.system': inferGenAiSystem(rec.resolved_model),
      'gen_ai.usage.input_tokens': Number.isInteger(rec.tokens_in) ? rec.tokens_in : null,
      'gen_ai.usage.output_tokens': Number.isInteger(rec.tokens_out) ? rec.tokens_out : null,
      // nubos-pilot's own dimensions, namespaced so they cannot collide with a
      // future convention key.
      'nubos.tier': rec.tier || null,
      'nubos.runtime': rec.runtime || null,
      'nubos.phase': rec.phase === '' ? null : (rec.phase || null),
      'nubos.plan': rec.plan || null,
      'nubos.task': rec.task || null,
      'nubos.retry_count': Number.isInteger(rec.retry_count) ? rec.retry_count : null,
      'nubos.status': rec.status || null,
      'nubos.error.code': rec.error && rec.error.code ? rec.error.code : null,
    },
  });
}

/**
 * Build the full OTLP payload from the planning hierarchy plus metrics records.
 *
 * @param {object} input
 * @param {string} input.projectId       stable project identifier (slug)
 * @param {object[]} input.milestones    [{id, name, status, slices: [{id, name, status, tasks: [{id, name, status}]}]}]
 * @param {object[]} input.records       metrics JSONL records
 * @param {object} [input.resource]      extra resource attributes
 * @param {string} [input.serviceName]
 * @returns {{payload: object, stats: object}}
 */
function buildPayload(input) {
  const cfg = input || {};
  const projectId = cfg.projectId;
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw _err('otlp-missing-project-id', 'buildPayload requires a non-empty projectId', {});
  }
  const milestones = Array.isArray(cfg.milestones) ? cfg.milestones : [];
  const records = Array.isArray(cfg.records) ? cfg.records : [];

  // Index records by the task they belong to so each lands under the right
  // parent. Records naming no task attach to their milestone instead of being
  // dropped — an unattributed spawn still cost tokens.
  const byTask = new Map();
  const looseByMilestone = new Map();
  let unattributed = 0;
  for (const rec of records) {
    const task = rec && rec.task;
    if (typeof task === 'string' && task.trim()) {
      if (!byTask.has(task)) byTask.set(task, []);
      byTask.get(task).push(rec);
      continue;
    }
    const ms = _milestoneOfPhase(rec && rec.phase);
    if (ms) {
      if (!looseByMilestone.has(ms)) looseByMilestone.set(ms, []);
      looseByMilestone.get(ms).push(rec);
    } else {
      unattributed += 1;
    }
  }

  const spans = [];
  const stats = {
    milestones: 0, slices: 0, tasks: 0, spawns: 0,
    skipped_untimed: 0, unattributed_records: unattributed,
  };

  for (const ms of milestones) {
    if (!ms || !ms.id) continue;
    const traceId = traceIdFor(projectId, ms.id);
    const msSpanId = spanIdFor(projectId, 'milestone/' + ms.id);
    let msStart = null;
    let msEnd = null;
    const msSpans = [];

    for (const slice of (Array.isArray(ms.slices) ? ms.slices : [])) {
      if (!slice || !slice.id) continue;
      const slSpanId = spanIdFor(projectId, 'slice/' + slice.id);
      let slStart = null;
      let slEnd = null;
      const slSpans = [];

      for (const task of (Array.isArray(slice.tasks) ? slice.tasks : [])) {
        if (!task || !task.id) continue;
        const tSpanId = spanIdFor(projectId, 'task/' + task.id);
        let tStart = null;
        let tEnd = null;
        const tSpans = [];

        for (const rec of (byTask.get(task.id) || [])) {
          const s = spawnSpan(rec, { traceId, projectId, parentSpanId: tSpanId });
          if (!s) { stats.skipped_untimed += 1; continue; }
          tSpans.push(s);
          tStart = _minNano(tStart, s.startTimeUnixNano);
          tEnd = _maxNano(tEnd, s.endTimeUnixNano);
        }

        // No timed descendant means no honest interval for the task itself.
        if (!tStart) { stats.skipped_untimed += 1; continue; }
        tSpans.push(_span({
          traceId, spanId: tSpanId, parentSpanId: slSpanId,
          name: 'task ' + task.id,
          startNano: tStart, endNano: tEnd,
          status: _statusCode(task.status),
          attrs: {
            'nubos.unit': 'task',
            'nubos.task': task.id,
            'nubos.task.name': task.name || null,
            'nubos.status': task.status || null,
          },
        }));
        stats.tasks += 1;
        stats.spawns += tSpans.length - 1;
        slSpans.push(...tSpans);
        slStart = _minNano(slStart, tStart);
        slEnd = _maxNano(slEnd, tEnd);
      }

      if (!slStart) { stats.skipped_untimed += 1; continue; }
      slSpans.push(_span({
        traceId, spanId: slSpanId, parentSpanId: msSpanId,
        name: 'slice ' + slice.id,
        startNano: slStart, endNano: slEnd,
        status: _statusCode(slice.status),
        attrs: {
          'nubos.unit': 'slice',
          'nubos.slice': slice.id,
          'nubos.slice.name': slice.name || null,
          'nubos.status': slice.status || null,
        },
      }));
      stats.slices += 1;
      msSpans.push(...slSpans);
      msStart = _minNano(msStart, slStart);
      msEnd = _maxNano(msEnd, slEnd);
    }

    for (const rec of (looseByMilestone.get(ms.id) || [])) {
      const s = spawnSpan(rec, { traceId, projectId, parentSpanId: msSpanId });
      if (!s) { stats.skipped_untimed += 1; continue; }
      msSpans.push(s);
      stats.spawns += 1;
      msStart = _minNano(msStart, s.startTimeUnixNano);
      msEnd = _maxNano(msEnd, s.endTimeUnixNano);
    }

    if (!msStart) { stats.skipped_untimed += 1; continue; }
    msSpans.push(_span({
      traceId, spanId: msSpanId, parentSpanId: null,
      name: 'milestone ' + ms.id,
      startNano: msStart, endNano: msEnd,
      status: _statusCode(ms.status),
      attrs: {
        'nubos.unit': 'milestone',
        'nubos.milestone': ms.id,
        'nubos.milestone.name': ms.name || null,
        'nubos.status': ms.status || null,
        'nubos.project': projectId,
      },
    }));
    stats.milestones += 1;
    spans.push(...msSpans);
  }

  const resourceAttrs = Object.assign({
    'service.name': cfg.serviceName || DEFAULT_SERVICE_NAME,
    'service.namespace': 'nubos-pilot',
    'nubos.project': projectId,
  }, cfg.resource || {});

  return {
    payload: {
      resourceSpans: [{
        resource: { attributes: attributes(resourceAttrs) },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
      }],
    },
    stats: Object.assign({ total_spans: spans.length }, stats),
  };
}

// A phase field of "3" or "M003" identifies the milestone a loose record belongs
// to. Both spellings occur in the wild because `--phase` is free-form text.
function _milestoneOfPhase(phase) {
  const p = String(phase == null ? '' : phase).trim();
  if (!p) return null;
  const m = p.match(/^M?(\d{1,3})$/);
  if (!m) return null;
  return 'M' + String(Number(m[1])).padStart(3, '0');
}

/**
 * POST the payload to an OTLP/HTTP endpoint.
 *
 * No dependency, no daemon: one request, resolved or rejected. The caller owns
 * the decision to send at all — nothing here fires unless the operator enabled
 * it and passed an endpoint.
 */
function postPayload(payload, opts) {
  const o = opts || {};
  if (typeof o.endpoint !== 'string' || !o.endpoint.trim()) {
    return Promise.reject(_err('otlp-missing-endpoint', 'An OTLP endpoint is required to export', {}));
  }
  let url;
  try {
    url = new URL(o.endpoint);
  } catch {
    return Promise.reject(_err('otlp-bad-endpoint', 'The OTLP endpoint is not a valid URL', {
      endpoint: o.endpoint,
    }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(_err(
      'otlp-bad-endpoint-protocol',
      'The OTLP endpoint must be http or https (got ' + url.protocol + ')',
      { endpoint: o.endpoint },
    ));
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const transport = url.protocol === 'https:' ? https : http;
  const headers = Object.assign({
    'content-type': 'application/json',
    'content-length': String(body.length),
  }, o.headers || {});
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf-8').slice(0, 2000);
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status, body: text, bytes_sent: body.length });
          return;
        }
        // A partial-success body is a 2xx in OTLP, so anything here is a real
        // rejection and must not be swallowed into a silent "exported".
        reject(_err('otlp-export-rejected', 'The OTLP endpoint rejected the export (HTTP ' + status + ')', {
          status, body: text,
        }));
      });
    });
    req.on('error', (err) => {
      reject(_err('otlp-transport-error', 'OTLP transport error: ' + (err && err.message), {
        endpoint: o.endpoint,
      }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(_err('otlp-timeout', 'The OTLP export timed out after ' + timeoutMs + ' ms', {
        endpoint: o.endpoint, timeout_ms: timeoutMs,
      }));
    });
    req.end(body);
  });
}

module.exports = {
  TRACE_ID_HEX,
  SPAN_ID_HEX,
  SPAN_KIND_INTERNAL,
  STATUS_UNSET,
  STATUS_OK,
  STATUS_ERROR,
  DEFAULT_SERVICE_NAME,
  DEFAULT_TIMEOUT_MS,
  FAILED_STATUSES,
  OK_STATUSES,
  deriveId,
  traceIdFor,
  spanIdFor,
  toUnixNano,
  attributes,
  inferGenAiSystem,
  spawnSpan,
  buildPayload,
  postPayload,
  _milestoneOfPhase,
  _statusCode,
};

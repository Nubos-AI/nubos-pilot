'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const otlp = require('./otlp.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

function _rec(over) {
  return Object.assign({
    agent: 'np-executor',
    tier: 'sonnet',
    resolved_model: 'claude-sonnet-5',
    phase: '3',
    plan: 'M003-S001',
    task: 'M003-S001-T0001',
    started_at: '2026-07-30T10:00:00.000Z',
    ended_at: '2026-07-30T10:00:05.000Z',
    duration_ms: 5000,
    tokens_in: 1200,
    tokens_out: 340,
    retry_count: 0,
    status: 'ok',
    runtime: 'claude',
    error: null,
    run_id: 'run-1',
  }, over || {});
}

function _hierarchy(over) {
  return Object.assign({
    projectId: 'demo-project',
    milestones: [{
      id: 'M003', name: 'Password reset', status: 'in-progress',
      slices: [{
        id: 'M003-S001', name: 'Token plumbing', status: 'done',
        tasks: [{ id: 'M003-S001-T0001', name: 'generate tokens', status: 'done' }],
      }],
    }],
    records: [_rec()],
  }, over || {});
}

function _spans(payload) {
  return payload.resourceSpans[0].scopeSpans[0].spans;
}

// ---------------------------------------------------------------------- ids

test('OT-1: ids are deterministic — a re-export updates one trace instead of duplicating', () => {
  const a = otlp.buildPayload(_hierarchy()).payload;
  const b = otlp.buildPayload(_hierarchy()).payload;
  assert.deepEqual(_spans(a).map((s) => s.spanId), _spans(b).map((s) => s.spanId));
  assert.deepEqual(_spans(a).map((s) => s.traceId), _spans(b).map((s) => s.traceId));
});

test('OT-2: ids have the OTLP hex widths', () => {
  assert.equal(otlp.traceIdFor('p', 'M001').length, otlp.TRACE_ID_HEX);
  assert.equal(otlp.spanIdFor('p', 'task/x').length, otlp.SPAN_ID_HEX);
  assert.match(otlp.traceIdFor('p', 'M001'), /^[0-9a-f]{32}$/);
  assert.match(otlp.spanIdFor('p', 'task/x'), /^[0-9a-f]{16}$/);
});

test('OT-3: different keys yield different ids; the same key is stable', () => {
  assert.notEqual(otlp.spanIdFor('p', 'task/a'), otlp.spanIdFor('p', 'task/b'));
  assert.notEqual(otlp.spanIdFor('p1', 'task/a'), otlp.spanIdFor('p2', 'task/a'));
  assert.equal(otlp.spanIdFor('p', 'task/a'), otlp.spanIdFor('p', 'task/a'));
});

test('OT-4: one trace per milestone, not per project', () => {
  assert.notEqual(otlp.traceIdFor('p', 'M001'), otlp.traceIdFor('p', 'M002'));
});

test('OT-5: an all-zero id is never emitted — OTLP reads it as "no span"', () => {
  // deriveId nudges a degenerate hash; assert the invariant on the guard itself.
  assert.ok(!/^0+$/.test(otlp.deriveId('anything', 16)));
  assert.equal(otlp.deriveId('anything', 16).length, 16);
});

// -------------------------------------------------------------------- times

test('OT-6: ISO timestamps convert to Unix nanoseconds as a decimal string', () => {
  assert.equal(otlp.toUnixNano('1970-01-01T00:00:01.000Z'), '1000000000');
  assert.equal(typeof otlp.toUnixNano('2026-07-30T10:00:00.000Z'), 'string');
});

test('OT-7: an unparseable time is null, distinct from epoch zero', () => {
  assert.equal(otlp.toUnixNano('not a date'), null);
  assert.equal(otlp.toUnixNano(''), null);
  assert.equal(otlp.toUnixNano(undefined), null);
  // Epoch 0 is a real instant and must not be conflated with "no time".
  assert.equal(otlp.toUnixNano('1970-01-01T00:00:00.000Z'), '0');
});

test('OT-8: nanosecond conversion stays exact past the 2^53 float ceiling', () => {
  const nano = otlp.toUnixNano('2026-07-30T10:00:00.123Z');
  assert.equal(nano, (BigInt(Date.parse('2026-07-30T10:00:00.123Z')) * 1000000n).toString());
  assert.ok(Number(nano) > Number.MAX_SAFE_INTEGER, 'sanity: this value exceeds float precision');
});

// --------------------------------------------------------------- attributes

test('OT-9: attributes drop nulls rather than emitting the string "null"', () => {
  const attrs = otlp.attributes({ a: 'x', b: null, c: undefined, d: 0, e: false });
  const keys = attrs.map((a) => a.key);
  assert.deepEqual(keys, ['a', 'd', 'e']);
});

test('OT-10: attribute values use the right OTLP value type', () => {
  const [s, i, f, b] = otlp.attributes({ s: 'x', i: 7, f: 1.5, b: true });
  assert.deepEqual(s.value, { stringValue: 'x' });
  assert.deepEqual(i.value, { intValue: '7' });
  assert.deepEqual(f.value, { doubleValue: 1.5 });
  assert.deepEqual(b.value, { boolValue: true });
});

test('OT-11: gen_ai.system is inferred only when the model prefix is unambiguous', () => {
  assert.equal(otlp.inferGenAiSystem('claude-sonnet-5'), 'anthropic');
  assert.equal(otlp.inferGenAiSystem('gpt-5-mini'), 'openai');
  assert.equal(otlp.inferGenAiSystem('gemini-3-pro'), 'gcp.gemini');
  // Guessing wrong is worse than omitting: a dashboard groups by this key.
  assert.equal(otlp.inferGenAiSystem('some-local-finetune'), null);
  assert.equal(otlp.inferGenAiSystem(''), null);
  assert.equal(otlp.inferGenAiSystem(undefined), null);
});

// -------------------------------------------------------------------- spans

test('OT-12: a spawn span carries the GenAI convention attributes', () => {
  const span = otlp.spawnSpan(_rec(), { traceId: 'a'.repeat(32), projectId: 'p', parentSpanId: 'b'.repeat(16) });
  const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
  assert.deepEqual(attrs['gen_ai.agent.name'], { stringValue: 'np-executor' });
  assert.deepEqual(attrs['gen_ai.request.model'], { stringValue: 'claude-sonnet-5' });
  assert.deepEqual(attrs['gen_ai.system'], { stringValue: 'anthropic' });
  assert.deepEqual(attrs['gen_ai.usage.input_tokens'], { intValue: '1200' });
  assert.deepEqual(attrs['gen_ai.usage.output_tokens'], { intValue: '340' });
  assert.equal(span.kind, otlp.SPAN_KIND_INTERNAL);
});

test('OT-13: a record with no usable start time yields no span', () => {
  assert.equal(otlp.spawnSpan(_rec({ started_at: 'nope' }), { traceId: 'x', projectId: 'p' }), null);
  assert.equal(otlp.spawnSpan({}, { traceId: 'x', projectId: 'p' }), null);
  assert.equal(otlp.spawnSpan(null, { traceId: 'x', projectId: 'p' }), null);
});

test('OT-14: a missing end time collapses to a zero-length span, not to null', () => {
  const span = otlp.spawnSpan(_rec({ ended_at: null }), { traceId: 'x', projectId: 'p' });
  assert.ok(span);
  assert.equal(span.startTimeUnixNano, span.endTimeUnixNano);
});

test('OT-15: retries of the same agent on the same task get distinct span ids', () => {
  const ctx = { traceId: 'x', projectId: 'p' };
  const a = otlp.spawnSpan(_rec({ run_id: 'run-1' }), ctx);
  const b = otlp.spawnSpan(_rec({ run_id: 'run-2' }), ctx);
  assert.notEqual(a.spanId, b.spanId, 'a retry must not overwrite the first attempt in the backend');
});

test('OT-16: status maps failed to ERROR, success to OK, and anything else to UNSET', () => {
  assert.equal(otlp._statusCode('failed'), otlp.STATUS_ERROR);
  assert.equal(otlp._statusCode('error'), otlp.STATUS_ERROR);
  assert.equal(otlp._statusCode('ok'), otlp.STATUS_OK);
  assert.equal(otlp._statusCode('verified'), otlp.STATUS_OK);
  // In-flight is UNSET, never OK — claiming OK for running work is a lie a
  // dashboard amplifies.
  assert.equal(otlp._statusCode('in-progress'), otlp.STATUS_UNSET);
  assert.equal(otlp._statusCode(undefined), otlp.STATUS_UNSET);
});

test('OT-17: an error record carries its message on the span status', () => {
  const span = otlp.spawnSpan(
    _rec({ status: 'failed', error: { code: 'verify-red', message: 'tests failed' } }),
    { traceId: 'x', projectId: 'p' },
  );
  assert.equal(span.status.code, otlp.STATUS_ERROR);
  assert.match(span.status.message, /tests failed/);
});

// ------------------------------------------------------------------ payload

test('OT-18: the payload nests milestone -> slice -> task -> spawn by parent id', () => {
  const { payload } = otlp.buildPayload(_hierarchy());
  const spans = _spans(payload);
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  const ms = byName['milestone M003'];
  const sl = byName['slice M003-S001'];
  const task = byName['task M003-S001-T0001'];
  const spawn = byName['agent np-executor'];

  assert.equal(ms.parentSpanId, undefined, 'the milestone is the trace root');
  assert.equal(sl.parentSpanId, ms.spanId);
  assert.equal(task.parentSpanId, sl.spanId);
  assert.equal(spawn.parentSpanId, task.spanId);
  // One trace across the whole milestone subtree.
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
});

test('OT-19: structural spans inherit their interval from timed descendants', () => {
  const { payload } = otlp.buildPayload(_hierarchy({
    records: [
      _rec({ run_id: 'a', started_at: '2026-07-30T10:00:00.000Z', ended_at: '2026-07-30T10:00:05.000Z' }),
      _rec({ run_id: 'b', started_at: '2026-07-30T10:00:10.000Z', ended_at: '2026-07-30T10:00:20.000Z' }),
    ],
  }));
  const byName = Object.fromEntries(_spans(payload).map((s) => [s.name, s]));
  assert.equal(byName['task M003-S001-T0001'].startTimeUnixNano, otlp.toUnixNano('2026-07-30T10:00:00.000Z'));
  assert.equal(byName['task M003-S001-T0001'].endTimeUnixNano, otlp.toUnixNano('2026-07-30T10:00:20.000Z'));
  assert.equal(byName['milestone M003'].endTimeUnixNano, otlp.toUnixNano('2026-07-30T10:00:20.000Z'));
});

test('OT-20: a slice whose tasks never ran is omitted, not stamped with now', () => {
  const { payload, stats } = otlp.buildPayload(_hierarchy({ records: [] }));
  assert.equal(_spans(payload).length, 0, 'an unrun hierarchy has no honest interval to report');
  assert.ok(stats.skipped_untimed > 0, 'skipping must be reported, not silent');
  assert.equal(stats.total_spans, 0);
});

test('OT-21: a record naming no task attaches to its milestone rather than being dropped', () => {
  const { payload, stats } = otlp.buildPayload(_hierarchy({
    records: [_rec({ task: null, phase: '3' })],
  }));
  const spans = _spans(payload);
  const ms = spans.find((s) => s.name === 'milestone M003');
  const spawn = spans.find((s) => s.name === 'agent np-executor');
  assert.ok(spawn, 'an unattributed spawn still cost tokens and must appear');
  assert.equal(spawn.parentSpanId, ms.spanId);
  assert.equal(stats.unattributed_records, 0);
});

test('OT-22: a record that maps to no milestone is counted as unattributed', () => {
  const { stats } = otlp.buildPayload(_hierarchy({
    records: [_rec({ task: null, phase: 'adhoc' })],
  }));
  assert.equal(stats.unattributed_records, 1);
});

test('OT-23: phase accepts both "3" and "M003" spellings', () => {
  assert.equal(otlp._milestoneOfPhase('3'), 'M003');
  assert.equal(otlp._milestoneOfPhase('M003'), 'M003');
  assert.equal(otlp._milestoneOfPhase('003'), 'M003');
  assert.equal(otlp._milestoneOfPhase('adhoc'), null);
  assert.equal(otlp._milestoneOfPhase(''), null);
  assert.equal(otlp._milestoneOfPhase(null), null);
});

test('OT-24: resource attributes carry the service and project identity', () => {
  const { payload } = otlp.buildPayload(_hierarchy({ serviceName: 'my-pilot' }));
  const attrs = Object.fromEntries(
    payload.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(attrs['service.name'], 'my-pilot');
  assert.equal(attrs['nubos.project'], 'demo-project');
});

test('OT-25: buildPayload requires a projectId — ids would not be stable without it', () => {
  assert.throws(() => otlp.buildPayload({ milestones: [], records: [] }), _code('otlp-missing-project-id'));
  assert.throws(() => otlp.buildPayload({ projectId: '  ' }), _code('otlp-missing-project-id'));
});

test('OT-26: stats count each unit type', () => {
  const { stats } = otlp.buildPayload(_hierarchy());
  assert.equal(stats.milestones, 1);
  assert.equal(stats.slices, 1);
  assert.equal(stats.tasks, 1);
  assert.equal(stats.spawns, 1);
  assert.equal(stats.total_spans, 4);
});

test('OT-27: malformed hierarchy entries are skipped rather than throwing', () => {
  assert.doesNotThrow(() => otlp.buildPayload({
    projectId: 'p',
    milestones: [null, {}, { id: 'M001', slices: [null, {}, { id: 'M001-S001', tasks: [null, {}] }] }],
    records: [],
  }));
});

// ---------------------------------------------------------------- transport

test('OT-28: postPayload refuses a missing or non-http endpoint before sending', async () => {
  await assert.rejects(() => otlp.postPayload({}, {}), _code('otlp-missing-endpoint'));
  await assert.rejects(() => otlp.postPayload({}, { endpoint: 'not a url' }), _code('otlp-bad-endpoint'));
  await assert.rejects(
    () => otlp.postPayload({}, { endpoint: 'file:///etc/passwd' }),
    _code('otlp-bad-endpoint-protocol'),
  );
});

test('OT-29: a 2xx resolves and reports the bytes sent', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"partialSuccess":{}}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { payload } = otlp.buildPayload(_hierarchy());
    const res = await otlp.postPayload(payload, {
      endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/traces',
      headers: { authorization: 'Basic redacted' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.ok(res.bytes_sent > 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['content-type'], 'application/json');
    assert.equal(received[0].headers.authorization, 'Basic redacted');
    assert.ok(JSON.parse(received[0].body).resourceSpans, 'the body must be a valid OTLP envelope');
  } finally {
    server.close();
  }
});

test('OT-30: a non-2xx rejects rather than being swallowed into a silent success', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => otlp.postPayload({ resourceSpans: [] }, {
        endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/traces',
      }),
      (err) => err.code === 'otlp-export-rejected' && err.details.status === 401,
    );
  } finally {
    server.close();
  }
});

test('OT-31: a connection failure surfaces as a transport error', async () => {
  // Port 1 on loopback: reliably refused, no listener to race with.
  await assert.rejects(
    () => otlp.postPayload({ resourceSpans: [] }, { endpoint: 'http://127.0.0.1:1/v1/traces' }),
    _code('otlp-transport-error'),
  );
});

test('OT-32: a hung endpoint times out instead of blocking forever', async () => {
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => otlp.postPayload({ resourceSpans: [] }, {
        endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/traces',
        timeoutMs: 120,
      }),
      _code('otlp-timeout'),
    );
  } finally {
    server.close();
  }
});

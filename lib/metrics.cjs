const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NubosPilotError, findProjectRoot } = require('./core.cjs');

const MAX_ERROR_MESSAGE = 300;

const MAX_ERROR_CODE = 40;

const MAX_RECORD_BYTES = 511;

const SCHEMA_FIELDS = [
  'agent', 'tier', 'resolved_model',
  'phase', 'plan', 'task',
  'started_at', 'ended_at', 'duration_ms',
  'tokens_in', 'tokens_out',
  'retry_count', 'status', 'runtime', 'error',
];

const REQUIRED_INPUT_FIELDS = [
  'agent', 'tier', 'resolved_model',
  'phase', 'plan', 'task',
  'started_at', 'ended_at',
  'status', 'runtime',
];

const SAFE_PHASE_RE = /^[A-Za-z0-9._-]+$/;

function _truncateError(err) {
  if (!err || typeof err !== 'object') return null;
  let code = typeof err.code === 'string' ? err.code : 'unknown';
  if (code.length > MAX_ERROR_CODE) code = code.slice(0, MAX_ERROR_CODE);
  let message = typeof err.message === 'string' ? err.message : '';
  if (message.length > MAX_ERROR_MESSAGE) {
    message = message.slice(0, MAX_ERROR_MESSAGE) + '…';
  }
  return { code, message };
}

function _durationMs(startedAt, endedAt) {
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.max(0, e - s);
}

function buildRecord(args) {
  const input = args || {};
  const missing = [];
  for (const f of REQUIRED_INPUT_FIELDS) {
    const v = input[f];
    if (v === undefined || v === null) {
      if (f === 'phase' && v === '') continue;
      missing.push(f);
    }
  }
  if (missing.length) {
    throw new NubosPilotError(
      'metrics-invalid-record',
      'metrics.buildRecord missing required fields: ' + missing.join(', '),
      { missing },
    );
  }

  const isClaude = input.runtime === 'claude';
  const record = {
    agent: String(input.agent),
    tier: String(input.tier),
    resolved_model: String(input.resolved_model),
    phase: String(input.phase),
    plan: String(input.plan),
    task: String(input.task),
    started_at: String(input.started_at),
    ended_at: String(input.ended_at),
    duration_ms: _durationMs(input.started_at, input.ended_at),
    tokens_in: isClaude && typeof input.tokens_in === 'number' ? input.tokens_in : null,
    tokens_out: isClaude && typeof input.tokens_out === 'number' ? input.tokens_out : null,
    retry_count: typeof input.retry_count === 'number' ? input.retry_count : 0,
    status: String(input.status),
    runtime: String(input.runtime),
    error: input.status === 'ok' ? null : _truncateError(input.error),
  };

  if (record.error && typeof record.error.message === 'string') {
    while (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) {
      const msg = record.error.message;
      const base = msg.endsWith('…') ? msg.slice(0, -1) : msg;
      if (base.length === 0) { record.error.message = ''; break; }
      record.error.message = base.slice(0, base.length - 1) + '…';
    }
  }

  return record;
}

function appendRecord(record, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const root = findProjectRoot(cwd);
  const dir = path.join(root, '.nubos-pilot', 'metrics');
  fs.mkdirSync(dir, { recursive: true });

  const phase = record.phase == null ? '' : String(record.phase);
  let file;
  if (phase === '') {
    file = path.join(dir, 'meta.jsonl');
  } else {
    if (!SAFE_PHASE_RE.test(phase)) {
      throw new NubosPilotError(
        'metrics-invalid-phase',
        'metrics.appendRecord phase must match /^[A-Za-z0-9._-]+$/: ' + phase,
        { phase },
      );
    }
    file = path.join(dir, 'phase-' + phase + '.jsonl');
  }
  fs.appendFileSync(file, JSON.stringify(record) + os.EOL);
  return file;
}

module.exports = { appendRecord, buildRecord, MAX_ERROR_MESSAGE, SCHEMA_FIELDS };

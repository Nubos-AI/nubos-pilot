const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const agg = require('./metrics-aggregate.cjs');
const { aggregatePhase, aggregateSession, _readJsonlLines } = agg;

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-metrics-agg-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'metrics'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

function writeJsonl(root, name, records) {
  const p = path.join(root, '.nubos-pilot', 'metrics', name);
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  fs.writeFileSync(p, lines);
  return p;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

function claudeRec(overrides) {
  return Object.assign({
    agent: 'np-executor', tier: 'sonnet', resolved_model: 'claude-sonnet-4-6',
    phase: '10', plan: '10-01', task: '10-01-T01',
    started_at: '2026-04-17T10:00:00Z',
    ended_at: '2026-04-17T10:00:01Z',
    duration_ms: 1000,
    tokens_in: 100, tokens_out: 50,
    retry_count: 0, status: 'ok', runtime: 'claude', error: null,
  }, overrides || {});
}

function codexRec(overrides) {
  return Object.assign({
    agent: 'np-executor', tier: 'sonnet', resolved_model: 'claude-sonnet-4-6',
    phase: '10', plan: '10-01', task: '10-01-T02',
    started_at: '2026-04-17T10:00:00Z',
    ended_at: '2026-04-17T10:00:01Z',
    duration_ms: 1000,
    tokens_in: null, tokens_out: null,
    retry_count: 0, status: 'ok', runtime: 'codex', error: null,
  }, overrides || {});
}

test('AGG-1: aggregatePhase on empty dir returns zero-shape', async () => {
  const sb = makeSandbox();
  const out = await aggregatePhase('10', { cwd: sb });
  assert.equal(out.phase, '10');
  assert.equal(out.record_count, 0);
  assert.equal(out.total_tokens_in, null);
  assert.equal(out.total_tokens_out, null);
  assert.deepEqual(out.avg_duration_ms_by_tier, {});
  assert.deepEqual(out.avg_duration_ms_by_agent, {});
  assert.equal(out.retry_count_sum, 0);
  assert.equal(out.error_count, 0);
  assert.equal(out.error_rate, 0);
  assert.deepEqual(out.agents_seen, []);
  assert.equal(out.first_record_at, null);
  assert.equal(out.last_record_at, null);
});

test('AGG-2: mixed claude + codex records → partial_tokens true; sum only claude tokens', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-10.jsonl', [
    claudeRec({ tokens_in: 100, tokens_out: 50 }),
    claudeRec({ tokens_in: 200, tokens_out: 75 }),
    codexRec(),
    codexRec(),
    codexRec(),
  ]);
  const out = await aggregatePhase('10', { cwd: sb });
  assert.equal(out.record_count, 5);
  assert.equal(out.total_tokens_in, 300);
  assert.equal(out.total_tokens_out, 125);
  assert.equal(out.partial_tokens, true);
});

test('AGG-3: all-codex records → total_tokens_in null, partial_tokens false', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-10.jsonl', [codexRec(), codexRec(), codexRec(), codexRec(), codexRec()]);
  const out = await aggregatePhase('10', { cwd: sb });
  assert.equal(out.record_count, 5);
  assert.equal(out.total_tokens_in, null);
  assert.equal(out.total_tokens_out, null);
  assert.equal(out.partial_tokens, false);
});

test('AGG-4: error_rate = error_count / record_count', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-10.jsonl', [
    claudeRec({ status: 'ok' }),
    claudeRec({ status: 'error' }),
    claudeRec({ status: 'ok' }),
    claudeRec({ status: 'timeout' }),
  ]);
  const out = await aggregatePhase('10', { cwd: sb });
  assert.equal(out.record_count, 4);
  assert.equal(out.error_count, 2);
  assert.equal(out.error_rate, 0.5);
});

test('AGG-5: avg_duration_ms buckets by tier and agent', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-10.jsonl', [
    claudeRec({ tier: 'opus', agent: 'alpha', duration_ms: 100 }),
    claudeRec({ tier: 'opus', agent: 'alpha', duration_ms: 200 }),
    claudeRec({ tier: 'opus', agent: 'alpha', duration_ms: 300 }),
    claudeRec({ tier: 'haiku', agent: 'beta', duration_ms: 500 }),
  ]);
  const out = await aggregatePhase('10', { cwd: sb });
  assert.equal(out.avg_duration_ms_by_tier.opus, 200);
  assert.equal(out.avg_duration_ms_by_tier.haiku, 500);
  assert.equal(out.avg_duration_ms_by_agent.alpha, 200);
  assert.equal(out.avg_duration_ms_by_agent.beta, 500);
  assert.deepEqual(out.agents_seen, ['alpha', 'beta']);
});

test('AGG-6: aggregateSession filters records below sinceIso', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-10.jsonl', [
    claudeRec({ started_at: '2026-04-17T08:00:00Z' }),
    claudeRec({ started_at: '2026-04-17T11:00:00Z' }),
    claudeRec({ started_at: '2026-04-17T12:00:00Z' }),
  ]);
  const out = await aggregateSession('2026-04-17T10:00:00Z', { cwd: sb });
  assert.equal(out.record_count, 2);
  assert.equal(out.since_iso, '2026-04-17T10:00:00Z');
});

test('AGG-7: aggregateSession reads all phase-*.jsonl + meta.jsonl', async () => {
  const sb = makeSandbox();
  writeJsonl(sb, 'phase-09.jsonl', [claudeRec({ phase: '09' })]);
  writeJsonl(sb, 'phase-10.jsonl', [claudeRec({ phase: '10' }), claudeRec({ phase: '10' })]);
  writeJsonl(sb, 'meta.jsonl', [claudeRec({ phase: null })]);
  const out = await aggregateSession(null, { cwd: sb });
  assert.ok(out.by_phase['09']);
  assert.ok(out.by_phase['10']);
  assert.ok(out.by_phase['meta']);
  assert.equal(out.by_phase['10'].record_count, 2);
  assert.equal(out.record_count, 4);
  assert.deepEqual(out.phases_touched.sort(), ['09', '10', 'meta']);
});

test('AGG-8: malformed line logs warning to stderr and skips, valid lines parse', async () => {
  const sb = makeSandbox();
  const p = path.join(sb, '.nubos-pilot', 'metrics', 'phase-10.jsonl');
  const lines = [
    JSON.stringify(claudeRec()),
    '{not valid json',
    JSON.stringify(claudeRec()),
    JSON.stringify(claudeRec()),
  ].join('\n') + '\n';
  fs.writeFileSync(p, lines);
  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  let out;
  try {
    out = await aggregatePhase('10', { cwd: sb });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(out.record_count, 3);
  assert.match(captured, /skipping malformed JSONL/);
});

test('AGG-9: path-traversal phase rejected with metrics-invalid-phase', async () => {
  const sb = makeSandbox();
  await assert.rejects(
    () => aggregatePhase('../etc/passwd', { cwd: sb }),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'metrics-invalid-phase',
  );
});

test('READJL-1: _readJsonlLines on missing file resolves without error', async () => {
  const sb = makeSandbox();
  const missing = path.join(sb, '.nubos-pilot', 'metrics', 'absent.jsonl');
  let records = [];
  await _readJsonlLines(missing, (r) => records.push(r));
  assert.equal(records.length, 0);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('./metrics.cjs');
const { appendRecord, buildRecord, MAX_ERROR_MESSAGE, SCHEMA_FIELDS } = metrics;

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-metrics-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

function validClaudeArgs(overrides) {
  return Object.assign({
    agent: 'np-executor',
    tier: 'sonnet',
    resolved_model: 'claude-sonnet-4-6',
    phase: '09',
    plan: '09-01',
    task: '09-01-T02',
    started_at: '2026-04-16T14:30:12.123Z',
    ended_at:   '2026-04-16T14:31:08.987Z',
    tokens_in: 3421,
    tokens_out: 812,
    retry_count: 0,
    status: 'ok',
    runtime: 'claude',
    error: null,
  }, overrides || {});
}

test('MET-1: SCHEMA_FIELDS equals D-08 15-field list in exact order', () => {
  assert.deepEqual(SCHEMA_FIELDS, [
    'agent', 'tier', 'resolved_model',
    'phase', 'plan', 'task',
    'started_at', 'ended_at', 'duration_ms',
    'tokens_in', 'tokens_out',
    'retry_count', 'status', 'runtime', 'error',
  ]);
  assert.equal(SCHEMA_FIELDS.length, 15);
});

test('MET-2: MAX_ERROR_MESSAGE equals 300', () => {
  assert.equal(MAX_ERROR_MESSAGE, 300);
});

test('MET-3: buildRecord with valid claude payload returns complete D-08 record', () => {
  const rec = buildRecord(validClaudeArgs());
  assert.equal(rec.agent, 'np-executor');
  assert.equal(rec.tier, 'sonnet');
  assert.equal(rec.resolved_model, 'claude-sonnet-4-6');
  assert.equal(rec.phase, '09');
  assert.equal(rec.plan, '09-01');
  assert.equal(rec.task, '09-01-T02');
  assert.equal(rec.started_at, '2026-04-16T14:30:12.123Z');
  assert.equal(rec.ended_at, '2026-04-16T14:31:08.987Z');
  const expectedDuration = Date.parse('2026-04-16T14:31:08.987Z') - Date.parse('2026-04-16T14:30:12.123Z');
  assert.equal(rec.duration_ms, expectedDuration);
  assert.equal(rec.tokens_in, 3421);
  assert.equal(rec.tokens_out, 812);
  assert.equal(rec.retry_count, 0);
  assert.equal(rec.status, 'ok');
  assert.equal(rec.runtime, 'claude');
  assert.equal(rec.error, null, 'error must be null when status=ok');
});

test('MET-4: buildRecord with status=error preserves error object shape', () => {
  const rec = buildRecord(validClaudeArgs({ status: 'error', error: { code: 'X', message: 'm' } }));
  assert.deepEqual(rec.error, { code: 'X', message: 'm' });
});

test('MET-5: buildRecord truncates overlong error.message to <=300 chars + ellipsis', () => {
  const rec = buildRecord(validClaudeArgs({
    status: 'error',
    error: { code: 'X', message: 'a'.repeat(1000) },
  }));
  assert.ok(
    rec.error.message.length <= 301,
    'char-cap: 300 content chars + 1 ellipsis; stricter byte-budget may cut further',
  );
  assert.ok(rec.error.message.endsWith('…'), 'truncated message ends with ellipsis');
  assert.equal(rec.error.message[0], 'a', 'kept content is the prefix of original message');
  assert.ok(
    rec.error.message.slice(0, -1).split('').every((c) => c === 'a'),
    'all kept characters are the original prefix',
  );
});

test('MET-6: buildRecord runtime=codex nulls tokens_in/tokens_out (D-09)', () => {
  const rec = buildRecord(validClaudeArgs({ runtime: 'codex', tokens_in: 9999, tokens_out: 9999 }));
  assert.equal(rec.tokens_in, null, 'tokens_in must be null for non-claude runtime');
  assert.equal(rec.tokens_out, null, 'tokens_out must be null for non-claude runtime');
  assert.equal(rec.runtime, 'codex');
});

test('MET-7: buildRecord({}) throws metrics-invalid-record with missing[] detail', () => {
  let thrown = null;
  try { buildRecord({}); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected throw on empty input');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'metrics-invalid-record');
  assert.ok(Array.isArray(thrown.details.missing), 'details.missing must be array');
  for (const f of ['agent', 'tier', 'phase', 'status', 'runtime']) {
    assert.ok(thrown.details.missing.includes(f), 'missing[] must include ' + f);
  }
});

test('MET-8: appendRecord routes phase=09 to phase-09.jsonl (one line, parseable)', () => {
  const sb = makeSandbox();
  const rec = buildRecord(validClaudeArgs());
  appendRecord(rec, { cwd: sb });
  const filePath = path.join(sb, '.nubos-pilot', 'metrics', 'phase-09.jsonl');
  assert.ok(fs.existsSync(filePath), 'phase-09.jsonl must exist');
  const lines = fs.readFileSync(filePath, 'utf-8').split(os.EOL).filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.phase, '09');
  assert.equal(parsed.task, '09-01-T02');
  assert.deepEqual(parsed, rec, 'round-trip JSON.parse must equal original record');
});

test('MET-9: appendRecord with phase="" routes to meta.jsonl (not phase-*.jsonl)', () => {
  const sb = makeSandbox();
  const rec1 = buildRecord(validClaudeArgs({ phase: '' }));
  const rec2 = buildRecord(validClaudeArgs({ phase: '', task: '09-01-T03' }));
  appendRecord(rec1, { cwd: sb });
  appendRecord(rec2, { cwd: sb });
  const metaPath = path.join(sb, '.nubos-pilot', 'metrics', 'meta.jsonl');
  assert.ok(fs.existsSync(metaPath), 'meta.jsonl must exist');
  const metaLines = fs.readFileSync(metaPath, 'utf-8').split(os.EOL).filter(Boolean);
  assert.equal(metaLines.length, 2, 'two appends must produce exactly two lines in meta.jsonl');
  const phaseFiles = fs.readdirSync(path.join(sb, '.nubos-pilot', 'metrics')).filter((f) => f.startsWith('phase-'));
  assert.equal(phaseFiles.length, 0, 'no phase-*.jsonl files should exist when phase=""');
});

test('MET-10: two sequential appendRecord calls produce two independently-parseable lines', () => {
  const sb = makeSandbox();
  const r1 = buildRecord(validClaudeArgs({ task: '09-01-T01' }));
  const r2 = buildRecord(validClaudeArgs({ task: '09-01-T02' }));
  appendRecord(r1, { cwd: sb });
  appendRecord(r2, { cwd: sb });
  const filePath = path.join(sb, '.nubos-pilot', 'metrics', 'phase-09.jsonl');
  const lines = fs.readFileSync(filePath, 'utf-8').split(os.EOL).filter(Boolean);
  assert.equal(lines.length, 2);
  const p1 = JSON.parse(lines[0]);
  const p2 = JSON.parse(lines[1]);
  assert.equal(p1.task, '09-01-T01');
  assert.equal(p2.task, '09-01-T02');
});

test('MET-11: worst-case record size under macOS PIPE_BUF=512 (Pitfall 1)', () => {
  const worst = buildRecord(validClaudeArgs({
    status: 'error',
    error: { code: 'a'.repeat(50), message: 'a'.repeat(1000) },
  }));
  const serialised = JSON.stringify(worst);
  assert.ok(
    serialised.length < 512,
    'Worst-case record is ' + serialised.length + ' bytes; must stay < 512 for macOS PIPE_BUF',
  );
});

test('MET-12: serialised record has no raw newline bytes even with multiline error message', () => {
  const rec = buildRecord(validClaudeArgs({
    status: 'error',
    error: { code: 'E', message: 'line1\nline2\nline3' },
  }));
  const serialised = JSON.stringify(rec);
  assert.equal(serialised.indexOf('\n'), -1, 'JSON-serialised record must have no raw newline bytes');
});

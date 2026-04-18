const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const subcmd = require('./metrics.cjs');

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-metrics-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

function captureStdio(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  let rc;
  try { rc = fn(); } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), rc };
}

function withCwd(cwd, fn) {
  const orig = process.cwd();
  process.chdir(cwd);
  try { return fn(); } finally { process.chdir(orig); }
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('MCLI-1: run(["now"]) / start-timestamp / end-timestamp all print ISO-ms timestamp and exit 0', () => {
  for (const sub of ['now', 'start-timestamp', 'end-timestamp']) {
    const cap = captureStdio(() => subcmd.run([sub]));
    assert.equal(cap.rc, 0, sub + ' must return 0');
    const line = cap.stdout.trim();
    assert.match(line, ISO_MS_RE, sub + ' must print ISO-8601 with ms: got ' + JSON.stringify(line));
  }
});

test('MCLI-2: run(record ...claude-full-argv) writes phase-09.jsonl and exits 0', () => {
  const cwd = makeSandbox();
  withCwd(cwd, () => {
    const cap = captureStdio(() => subcmd.run([
      'record',
      '--agent', 'np-executor',
      '--tier', 'sonnet',
      '--resolved-model', 'claude-sonnet-4-6',
      '--phase', '09',
      '--plan', '09-01',
      '--task', '09-01-T02',
      '--started', '2026-04-16T14:30:12.123Z',
      '--ended', '2026-04-16T14:31:08.987Z',
      '--tokens-in', '3421',
      '--tokens-out', '812',
      '--status', 'ok',
      '--runtime', 'claude',
    ]));
    assert.equal(cap.rc, 0, 'stderr was: ' + cap.stderr);
    const filePath = path.join(cwd, '.nubos-pilot', 'metrics', 'phase-09.jsonl');
    assert.ok(fs.existsSync(filePath));
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').split(os.EOL).filter(Boolean)[0]);
    assert.equal(parsed.phase, '09');
    assert.equal(parsed.tokens_in, 3421);
    assert.equal(parsed.runtime, 'claude');
  });
});

test('MCLI-3: run(record ...phase="" runtime=codex) routes to meta.jsonl with null tokens (D-09)', () => {
  const cwd = makeSandbox();
  withCwd(cwd, () => {
    const cap = captureStdio(() => subcmd.run([
      'record',
      '--agent', 'np-executor',
      '--tier', 'sonnet',
      '--resolved-model', 'claude-sonnet-4-6',
      '--phase', '',
      '--plan', '',
      '--task', '',
      '--started', '2026-04-16T14:30:12.123Z',
      '--ended', '2026-04-16T14:31:08.987Z',
      '--tokens-in', '9999',
      '--tokens-out', '9999',
      '--status', 'ok',
      '--runtime', 'codex',
    ]));
    assert.equal(cap.rc, 0, 'stderr: ' + cap.stderr);
    const metaPath = path.join(cwd, '.nubos-pilot', 'metrics', 'meta.jsonl');
    assert.ok(fs.existsSync(metaPath));
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8').split(os.EOL).filter(Boolean)[0]);
    assert.equal(parsed.phase, '');
    assert.equal(parsed.runtime, 'codex');
    assert.equal(parsed.tokens_in, null);
    assert.equal(parsed.tokens_out, null);
  });
});

test('MCLI-4: run(record --json @file:<path>) reads JSON blob and emits schema-identical record', () => {
  const cwd = makeSandbox();
  const jsonPayload = {
    agent: 'np-eval-planner',
    tier: 'opus',
    resolved_model: 'claude-opus-4-7',
    phase: '09',
    plan: '09-02',
    task: '09-02-T03',
    started_at: '2026-04-16T14:30:12.123Z',
    ended_at: '2026-04-16T14:31:08.987Z',
    tokens_in: 100,
    tokens_out: 50,
    retry_count: 0,
    status: 'error',
    runtime: 'claude',
    error: { code: 'eval-timeout', message: 'the agent timed out waiting for a long response' },
  };
  const jsonPath = path.join(cwd, 'payload.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload));
  withCwd(cwd, () => {
    const cap = captureStdio(() => subcmd.run(['record', '--json', '@file:' + jsonPath]));
    assert.equal(cap.rc, 0, 'stderr: ' + cap.stderr);
    const filePath = path.join(cwd, '.nubos-pilot', 'metrics', 'phase-09.jsonl');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').split(os.EOL).filter(Boolean)[0]);
    assert.equal(parsed.agent, 'np-eval-planner');
    assert.equal(parsed.task, '09-02-T03');
    assert.deepEqual(parsed.error, { code: 'eval-timeout', message: jsonPayload.error.message });
  });
});

test('MCLI-5: run(record ...missing fields) exits 1 and writes JSON error envelope to stderr', () => {
  const cwd = makeSandbox();
  withCwd(cwd, () => {
    const cap = captureStdio(() => subcmd.run([
      'record',
      '--agent', 'np-executor',
      '--tier', 'sonnet',
    ]));
    assert.equal(cap.rc, 1);
    const parsed = JSON.parse(cap.stderr.trim());
    assert.equal(parsed.code, 'metrics-invalid-record');
    assert.ok(Array.isArray(parsed.details.missing));
  });
});

test('MCLI-6: run(record --error-code E1 --error-message boom --status error) writes error={code,message}', () => {
  const cwd = makeSandbox();
  withCwd(cwd, () => {
    const cap = captureStdio(() => subcmd.run([
      'record',
      '--agent', 'np-executor',
      '--tier', 'opus',
      '--resolved-model', 'claude-opus-4-7',
      '--phase', '09',
      '--plan', '09-02',
      '--task', '09-02-T01',
      '--started', '2026-04-16T14:30:12.123Z',
      '--ended', '2026-04-16T14:31:08.987Z',
      '--status', 'error',
      '--runtime', 'claude',
      '--error-code', 'E1',
      '--error-message', 'boom',
    ]));
    assert.equal(cap.rc, 0, 'stderr: ' + cap.stderr);
    const filePath = path.join(cwd, '.nubos-pilot', 'metrics', 'phase-09.jsonl');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').split(os.EOL).filter(Boolean)[0]);
    assert.deepEqual(parsed.error, { code: 'E1', message: 'boom' });
  });
});

test('MCLI-7: run(["unknown-subcommand"]) exits 1 with usage on stderr', () => {
  const cap = captureStdio(() => subcmd.run(['unknown-subcommand']));
  assert.equal(cap.rc, 1);
  assert.match(cap.stderr, /Usage/i);
});

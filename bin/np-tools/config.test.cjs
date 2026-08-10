const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const configCli = require('./config.cjs');

const _sandboxes = [];

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandbox(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-config-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), JSON.stringify(config));
  }
  _sandboxes.push(root);
  return root;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

test('CONFIG-1: reads a nested string value via dotted path', () => {
  const sb = makeSandbox({ review: { models: { gemini: 'gemini-2.5-pro' } } });
  const stdout = makeSink();
  const stderr = makeSink();
  const code = configCli.run(['review.models.gemini', '--raw'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), 'gemini-2.5-pro');
});

test('CONFIG-2: missing key prints empty line and exits 0', () => {
  const sb = makeSandbox({ workflow: {} });
  const stdout = makeSink();
  const stderr = makeSink();
  const code = configCli.run(['workflow.nonexistent'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '\n');
});

test('CONFIG-3: __proto__ segment rejected with config-forbidden-key', () => {
  const sb = makeSandbox({ a: 1 });
  const stdout = makeSink();
  const stderr = makeSink();
  const code = configCli.run(['__proto__.polluted'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"config-forbidden-key"/);
});

test('CONFIG-4: object value serialized as JSON', () => {
  const sb = makeSandbox({ workflow: { nested: { k: 'v' } } });
  const stdout = makeSink();
  const stderr = makeSink();
  const code = configCli.run(['workflow.nested', '--raw'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '{"k":"v"}');
});

test('CONFIG-5: returns DEFAULT_CONFIG_TREE value when key absent from user config', () => {
  const sb = makeSandbox({ runtime: 'claude' });
  const stdout = makeSink();
  const code = configCli.run(['loop.maxRounds'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '3\n');
});

test('CONFIG-6: defaults walk into nested swarm.research.* keys', () => {
  const sb = makeSandbox({});
  const out1 = makeSink(); configCli.run(['swarm.research.k'], { cwd: sb, stdout: out1, stderr: makeSink() });
  const out2 = makeSink(); configCli.run(['swarm.research.threshold'], { cwd: sb, stdout: out2, stderr: makeSink() });
  const out3 = makeSink(); configCli.run(['swarm.research.minOccurrence'], { cwd: sb, stdout: out3, stderr: makeSink() });
  assert.equal(out1.toString(), '3\n');
  assert.equal(out2.toString(), '0.2\n');
  assert.equal(out3.toString(), '1\n');
});

test('CONFIG-7: user-set value wins over default', () => {
  const sb = makeSandbox({ loop: { maxRounds: 5 } });
  const stdout = makeSink();
  configCli.run(['loop.maxRounds'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(stdout.toString(), '5\n');
});

test('CONFIG-8: partial user override falls through to defaults for sibling keys', () => {
  const sb = makeSandbox({ swarm: { research: { k: 7 } } });
  const k = makeSink(); configCli.run(['swarm.research.k'], { cwd: sb, stdout: k, stderr: makeSink() });
  const t = makeSink(); configCli.run(['swarm.research.threshold'], { cwd: sb, stdout: t, stderr: makeSink() });
  assert.equal(k.toString(), '7\n');
  assert.equal(t.toString(), '0.2\n');
});

test('CONFIG-9: unknown key without a default still returns empty', () => {
  const sb = makeSandbox({});
  const stdout = makeSink();
  configCli.run(['really.not.a.thing'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(stdout.toString(), '\n');
});

test('CONFIG-10: defaults resolve even without config.json present', () => {
  const sb = makeSandbox();
  const stdout = makeSink();
  configCli.run(['loop.maxRounds'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(stdout.toString(), '3\n');
});

test('CONFIG-11: explicit user false wins over default true (boolean handling)', () => {
  const sb = makeSandbox({ auto_log_learning: false });
  const stdout = makeSink();
  configCli.run(['auto_log_learning'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(stdout.toString(), 'false\n');
});

test('CONFIG-12: --raw mode resolves defaults without trailing newline', () => {
  const sb = makeSandbox({});
  const stdout = makeSink();
  configCli.run(['loop.maxRounds', '--raw'], { cwd: sb, stdout, stderr: makeSink() });
  assert.equal(stdout.toString(), '3');
});

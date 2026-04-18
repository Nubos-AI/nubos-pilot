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

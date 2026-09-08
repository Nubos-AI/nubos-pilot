const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const cli = require('./detect-runtime.cjs');

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandbox(runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-detect-rt-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (runtime) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ runtime, runtime_source: 'config' }),
    );
  }
  return root;
}

test('detect-runtime: reads runtime from .nubos-pilot/config.json', () => {
  const sb = makeSandbox('gemini');
  const stdout = makeSink();
  const code = cli.run([], { cwd: sb, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.toString().trim(), 'gemini');
});

test('detect-runtime --json emits {runtime, source}', () => {
  const sb = makeSandbox('codex');
  const stdout = makeSink();
  const code = cli.run(['--json'], { cwd: sb, stdout });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed.runtime, 'codex');
  assert.ok(parsed.source);
});

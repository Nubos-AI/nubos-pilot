const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const slugCli = require('./slug.cjs');

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

test('SLUG-1: happy path slugifies a phrase', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = slugCli.run(['Hello World Test', '--raw'], { stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), 'hello-world-test');
});

test('SLUG-2: missing text prints usage', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = slugCli.run([], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});

test('SLUG-3: non-raw output has trailing newline', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = slugCli.run(['Fix deploy key auth'], { stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), 'fix-deploy-key-auth\n');
});

test('SLUG-4: collapses repeated separators + strips leading/trailing', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = slugCli.run(['  --FOO  BAR!!!  ', '--raw'], { stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), 'foo-bar');
});

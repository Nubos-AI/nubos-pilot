const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const askuserCli = require('./askuser.cjs');
const askuserLib = require('../../lib/askuser.cjs');

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

test('ASKUSER-1: happy path returns chosen label via readline test-hook', async (t) => {
  askuserLib._setReadlineImplForTests(() => '2');
  t.after(() => askuserLib._setReadlineImplForTests(null));
  const stdout = makeSink();
  const stderr = makeSink();
  const spec = { type: 'select', question: 'Choose', options: ['alpha', 'beta', 'gamma'] };
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  let code;
  try {
    code = await askuserCli.run(['--json', JSON.stringify(spec)], { stdout, stderr });
  } finally {
    process.stdout.write = origStdoutWrite;
  }
  assert.equal(code, 0);
  assert.match(stdout.toString(), /beta/);
});

test('ASKUSER-2: invalid JSON emits askuser-invalid-json on stderr', async () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await askuserCli.run(['--json', '{not json'], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"askuser-invalid-json"/);
});

test('ASKUSER-3: missing --json prints usage to stderr', async () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await askuserCli.run([], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});

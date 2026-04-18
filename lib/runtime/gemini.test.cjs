const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { _setReadlineImplForTests } = require('./_readline.cjs');
const gemini = require('./gemini.cjs');

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stderr.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stderr.write = orig; throw err; },
  );
}

test('gemini-adapter: exports five-key contract', () => {
  for (const k of ['name', 'detectHints', 'capabilities', 'paths', 'askUser']) {
    assert.ok(k in gemini, 'missing ' + k);
  }
  assert.equal(gemini.name, 'gemini');
});

test('gemini-adapter: capabilities match D-07 + D-17', () => {
  const c = gemini.capabilities;
  assert.equal(c.askUserQuestion, false);
  assert.equal(c.slashCommands, false);
  assert.equal(
    c.agentsMd,
    'GEMINI.md',
    'D-17: Gemini reads GEMINI.md as default context file',
  );
  assert.equal(c.textMode, 'auto');
  assert.equal(c.modelResolution, 'profile');
});

test('gemini-adapter: paths.agentsMd is root-level GEMINI.md', () => {
  assert.equal(
    gemini.paths.agentsMd,
    'GEMINI.md',
    'D-17: GEMINI.md at project root, not in .gemini/ subdir',
  );
  assert.equal(gemini.paths.payload, null);
  assert.equal(gemini.paths.config, null);
});

test('gemini-adapter: readline select parses 1-based index', async () => {
  _setReadlineImplForTests(async () => '2');
  try {
    const { val } = await captureStderr(() =>
      gemini.askUser({ type: 'select', question: 'P', options: ['A', 'B'] }),
    );
    assert.equal(val.value, 'B');
    assert.equal(val.source, 'readline');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('gemini-adapter: readline input', async () => {
  _setReadlineImplForTests(async () => 'ok');
  try {
    const { val } = await captureStderr(() =>
      gemini.askUser({ type: 'input', question: 'Q' }),
    );
    assert.equal(val.value, 'ok');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('gemini-adapter: readline confirm', async () => {
  _setReadlineImplForTests(async () => 'y');
  try {
    const { val } = await captureStderr(() =>
      gemini.askUser({ type: 'confirm', question: 'OK' }),
    );
    assert.equal(val.value, true);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('gemini-adapter: single responsibility — no install-layer imports, no direct readline', () => {
  const src = fs.readFileSync(require.resolve('./gemini.cjs'), 'utf-8');
  assert.ok(
    !/require\(['"]\.\.\/install\//.test(src),
    'gemini.cjs must not reach into lib/install/',
  );
  assert.ok(
    !/require\(['"]node:readline['"]\)/.test(src),
    'gemini.cjs must delegate to _readline.cjs',
  );
});

test('gemini-adapter: exports runtimeNotice compatible with agents-md SC-5 check', () => {
  const notice = gemini.runtimeNotice;
  assert.equal(typeof notice, 'string');
  assert.ok(notice.length > 0);
  assert.match(notice, /readline|prompt/i, 'runtimeNotice must match /readline|prompt/i');
});

test('gemini-adapter: runtimeNotice references GEMINI.md', () => {
  assert.ok(gemini.runtimeNotice.includes('GEMINI.md'));
});

test('gemini-adapter: runtimeNotice does not contain the forbidden joined Claude-tool literal (SC-5 guard)', () => {
  assert.ok(!/Ask-User-Question/.test(gemini.runtimeNotice));
});

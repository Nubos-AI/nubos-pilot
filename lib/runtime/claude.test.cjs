const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _setReadlineImplForTests } = require('./_readline.cjs');
const claude = require('./claude.cjs');

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stdout.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stdout.write = orig; throw err; },
  );
}

test('claude-adapter: exports five-key contract', () => {
  for (const k of ['name', 'detectHints', 'capabilities', 'paths', 'askUser']) {
    assert.ok(k in claude, 'missing ' + k);
  }
  assert.equal(claude.name, 'claude');
});

test('claude-adapter: capabilities match D-07 spec', () => {
  const c = claude.capabilities;
  assert.equal(c.askUserQuestion, true);
  assert.equal(c.slashCommands, true);
  assert.equal(c.agentsMd, 'CLAUDE.md');
  assert.equal(c.textMode, 'off');
  assert.equal(c.modelResolution, 'profile');
});

test('claude-adapter: askUser emits askUser v1 marker block', async () => {
  _setReadlineImplForTests(async () => 'chosen');
  try {
    const { val, out } = await captureStdout(() =>
      claude.askUser({ type: 'input', question: 'Q' })
    );
    assert.match(out, /<!-- askUser v1 -->/);
    assert.match(out, /<!-- \{"type":"input"/);
    assert.equal(val.source, 'askUserQuestion');
    assert.equal(val.value, 'chosen');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('claude-adapter: select with injected index returns option', async () => {
  _setReadlineImplForTests(async () => '2');
  try {
    const { val } = await captureStdout(() =>
      claude.askUser({ type: 'select', question: 'P', options: ['A', 'B', 'C'] })
    );
    assert.equal(val.value, 'B');
    assert.equal(val.source, 'askUserQuestion');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('claude-adapter: confirm y/n parsing', async () => {
  _setReadlineImplForTests(async () => 'y');
  try {
    const { val } = await captureStdout(() =>
      claude.askUser({ type: 'confirm', question: 'OK' })
    );
    assert.equal(val.value, true);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('claude-adapter: marker JSON payload has exact key order', async () => {
  _setReadlineImplForTests(async () => 'x');
  try {
    const { out } = await captureStdout(() =>
      claude.askUser({ type: 'input', question: 'Q', options: ['a'], default: 'd' })
    );
    assert.match(out, /"type":"input","question":"Q","options":\["a"\],"default":"d"/);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('claude-adapter: does not import node:readline directly', () => {
  const src = require('fs').readFileSync(require.resolve('./claude.cjs'), 'utf-8');
  assert.ok(
    !/require\(['"]node:readline['"]\)/.test(src),
    'claude.cjs must delegate to _readline.cjs, not require node:readline',
  );
});

test('claude-adapter: exports runtimeNotice compatible with agents-md SC-5 check', () => {
  const notice = claude.runtimeNotice;
  assert.equal(typeof notice, 'string');
  assert.ok(notice.length > 0);
  assert.match(notice, /readline|prompt/i, 'runtimeNotice must match /readline|prompt/i');
});

test('claude-adapter: runtimeNotice does not contain the forbidden joined Claude-tool literal (SC-5 guard)', () => {
  assert.ok(!/Ask-User-Question/.test(claude.runtimeNotice));
});

test('claude-adapter: askUser without TTY and without default throws askuser-no-tty', async () => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    _setReadlineImplForTests(null);
    await assert.rejects(
      () => claude.askUser({ type: 'select', question: 'P', options: ['A', 'B'] }),
      (err) => err && err.code === 'askuser-no-tty',
    );
  } finally {
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  }
});

test('claude-adapter: askUser with TTY stdin uses readline UI, no marker block', async () => {
  const originalIsTTY = process.stdin.isTTY;
  _setReadlineImplForTests(async () => '2');
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stderrChunks = [];
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const { val, out } = await captureStdout(() =>
      claude.askUser({ type: 'select', question: 'Q', options: ['A', 'B', 'C'] })
    );
    assert.ok(!/<!-- askUser v1 -->/.test(out),
      'must not emit marker block when stdin is TTY');
    assert.equal(val.source, 'readline');
    assert.equal(val.value, 'B');
    const stderrJoined = stderrChunks.join('');
    assert.match(stderrJoined, /Q/, 'readline UI should render the question on stderr');
  } finally {
    process.stderr.write = originalStderrWrite;
    _setReadlineImplForTests(null);
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  }
});

test('claude-adapter: askUser without TTY but with default returns default', async () => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    _setReadlineImplForTests(null);
    const res = await claude.askUser({ type: 'confirm', question: 'OK?', default: true });
    assert.equal(res.value, true);
    assert.equal(res.source, 'default');
  } finally {
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  }
});

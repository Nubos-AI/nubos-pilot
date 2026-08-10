const test = require('node:test');
const assert = require('node:assert/strict');

const au = require('./askuser.cjs');

const RUNTIME_ENV_KEYS = [
  'NUBOS_RUNTIME',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_HOME',
  'CODEX_VERSION',
  'GEMINI_CLI',
  'GEMINI_VERSION',
  'OPENCODE',
  'OPENCODE_VERSION',
  'NUBOS_PILOT_REDETECT_RUNTIME',
];

function snapshotEnv() {
  const snap = {};
  for (const k of RUNTIME_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of RUNTIME_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function clearAllRuntimeEnv() {
  for (const k of RUNTIME_ENV_KEYS) delete process.env[k];
}
function forceRedetect() {
  process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';
}

function withEnv(mutator, fn) {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    mutator();
    forceRedetect();
    return fn();
  } finally {
    restoreEnv(snap);
    au._setReadlineImplForTests(null);
  }
}

test('AU-1: NUBOS_RUNTIME=claude explicit override → claude', () => {
  withEnv(() => { process.env.NUBOS_RUNTIME = 'claude'; }, () => {
    assert.equal(au._detectRuntime(), 'claude');
  });
});

test('AU-2: NUBOS_RUNTIME=generic-readline beats CLAUDECODE=1 (Pitfall 4)', () => {
  withEnv(() => {
    process.env.NUBOS_RUNTIME = 'generic-readline';
    process.env.CLAUDECODE = '1';
  }, () => {
    assert.equal(au._detectRuntime(), 'generic-readline');
  });
});

test('AU-3: CLAUDECODE=1 → claude', () => {
  withEnv(() => { process.env.CLAUDECODE = '1'; }, () => {
    assert.equal(au._detectRuntime(), 'claude');
  });
});

test('AU-4: CODEX_HOME set → codex', () => {
  withEnv(() => { process.env.CODEX_HOME = '/foo'; }, () => {
    assert.equal(au._detectRuntime(), 'codex');
  });
});

test('AU-5: GEMINI_CLI set → gemini', () => {
  withEnv(() => { process.env.GEMINI_CLI = '1'; }, () => {
    assert.equal(au._detectRuntime(), 'gemini');
  });
});

test('AU-6: OPENCODE_VERSION set → opencode', () => {
  withEnv(() => { process.env.OPENCODE_VERSION = 'x'; }, () => {
    assert.equal(au._detectRuntime(), 'opencode');
  });
});

test('AU-7: no env vars → generic-readline', () => {
  withEnv(() => {}, () => {
    assert.equal(au._detectRuntime(), 'generic-readline');
  });
});

test('AU-8: getRuntime caches — mutation without redetect flag does not change result', () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    process.env.CLAUDECODE = '1';
    forceRedetect();
    const first = au.getRuntime();
    assert.equal(first, 'claude');
    delete process.env.NUBOS_PILOT_REDETECT_RUNTIME;
    delete process.env.CLAUDECODE;
    process.env.CODEX_HOME = '/y';
    const second = au.getRuntime();
    assert.equal(second, 'claude');
  } finally {
    restoreEnv(snap);
  }
});

test('AU-9: getRuntime re-detects when NUBOS_PILOT_REDETECT_RUNTIME=1', () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    process.env.CLAUDECODE = '1';
    forceRedetect();
    assert.equal(au.getRuntime(), 'claude');
    delete process.env.CLAUDECODE;
    process.env.CODEX_HOME = '/z';
    process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';
    assert.equal(au.getRuntime(), 'codex');
  } finally {
    restoreEnv(snap);
  }
});

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stdout.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stdout.write = orig; throw err; },
  );
}
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stderr.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stderr.write = orig; throw err; },
  );
}

test('AU-10: Claude branch emits askUser v1 marker-block to stdout', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    process.env.NUBOS_RUNTIME = 'claude';
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => 'chosen');
    const { val, out } = await captureStdout(() =>
      au.askUser({ type: 'input', question: 'Q' })
    );
    assert.match(out, /<!-- askUser v1 -->/);
    assert.equal(val.source, 'askUserQuestion');
    assert.equal(val.value, 'chosen');
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-11: marker-block inner JSON contains type, question, options, default keys', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    process.env.NUBOS_RUNTIME = 'claude';
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => '1');
    const { out } = await captureStdout(() =>
      au.askUser({ type: 'select', question: 'Pick', options: ['A', 'B'], default: null })
    );
    const match = out.match(/<!--\s*(\{[^]*?\})\s*-->/);
    assert.ok(match, 'inner JSON comment missing');
    const parsed = JSON.parse(match[1]);
    assert.equal(parsed.type, 'select');
    assert.equal(parsed.question, 'Pick');
    assert.deepEqual(parsed.options, ['A', 'B']);
    assert.equal('default' in parsed, true);
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-12: readline fallback select parses 1-based index', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => '2');
    const { val } = await captureStderr(() =>
      au.askUser({ type: 'select', question: 'P', options: ['A', 'B', 'C'] })
    );
    assert.equal(val.value, 'B');
    assert.equal(val.source, 'readline');
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-13: readline fallback confirm y/n/default', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => 'y');
    const { val: v1 } = await captureStderr(() =>
      au.askUser({ type: 'confirm', question: 'OK?' })
    );
    assert.equal(v1.value, true);

    au._setReadlineImplForTests(async () => 'n');
    const { val: v2 } = await captureStderr(() =>
      au.askUser({ type: 'confirm', question: 'OK?' })
    );
    assert.equal(v2.value, false);

    au._setReadlineImplForTests(async () => '');
    const { val: v3 } = await captureStderr(() =>
      au.askUser({ type: 'confirm', question: 'OK?', default: true })
    );
    assert.equal(v3.value, true);
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-14: readline fallback input returns line verbatim', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => 'hello');
    const { val } = await captureStderr(() =>
      au.askUser({ type: 'input', question: 'Name?' })
    );
    assert.equal(val.value, 'hello');
    assert.equal(val.source, 'readline');
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-15: readline multiselect parses comma-separated 1-based indices', async () => {
  const snap = snapshotEnv();
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(async () => '1,3');
    const { val } = await captureStderr(() =>
      au.askUser({ type: 'multiselect', question: 'Pick', options: ['A', 'B', 'C'] })
    );
    assert.deepEqual(val.value, ['A', 'C']);
    assert.equal(val.source, 'readline');
  } finally {
    au._setReadlineImplForTests(null);
    restoreEnv(snap);
  }
});

test('AU-16: no TTY, no injected impl, no default → throws askuser-no-tty', async () => {
  const snap = snapshotEnv();
  const origIsTTY = process.stdin.isTTY;
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await assert.rejects(
      () => au.askUser({ type: 'input', question: 'Q' }),
      (err) => err && err.code === 'askuser-no-tty',
    );
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    restoreEnv(snap);
  }
});

test('AU-17: no TTY with default provided → returns default', async () => {
  const snap = snapshotEnv();
  const origIsTTY = process.stdin.isTTY;
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    au.getRuntime();
    au._setReadlineImplForTests(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const res = await au.askUser({ type: 'input', question: 'Q', default: 'fallback' });
    assert.equal(res.value, 'fallback');
    assert.equal(res.source, 'default');
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    restoreEnv(snap);
  }
});

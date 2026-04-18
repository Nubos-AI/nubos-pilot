const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { _setReadlineImplForTests } = require('./_readline.cjs');
const codex = require('./codex.cjs');

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stderr.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stderr.write = orig; throw err; },
  );
}

test('codex-adapter: exports five-key contract', () => {
  for (const k of ['name', 'detectHints', 'capabilities', 'paths', 'askUser']) {
    assert.ok(k in codex, 'missing ' + k);
  }
  assert.equal(codex.name, 'codex');
});

test('codex-adapter: capabilities match D-07 spec', () => {
  const c = codex.capabilities;
  assert.equal(c.askUserQuestion, false);
  assert.equal(c.slashCommands, false);
  assert.equal(c.agentsMd, 'AGENTS.md');
  assert.equal(c.textMode, 'auto');
  assert.equal(c.modelResolution, 'profile');
});

test('codex-adapter: paths are null for payload/config (codex has no per-project tree)', () => {
  assert.equal(codex.paths.payload, null);
  assert.equal(codex.paths.config, null);
  assert.equal(codex.paths.agentsMd, 'AGENTS.md');
});

test('codex-adapter: readline select returns option', async () => {
  _setReadlineImplForTests(async () => '1');
  try {
    const { val } = await captureStderr(() =>
      codex.askUser({ type: 'select', question: 'P', options: ['A', 'B'] }),
    );
    assert.equal(val.value, 'A');
    assert.equal(val.source, 'readline');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('codex-adapter: readline input returns line', async () => {
  _setReadlineImplForTests(async () => 'hi');
  try {
    const { val } = await captureStderr(() =>
      codex.askUser({ type: 'input', question: 'Q' }),
    );
    assert.equal(val.value, 'hi');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('codex-adapter: readline confirm yes/no', async () => {
  _setReadlineImplForTests(async () => 'yes');
  try {
    const { val } = await captureStderr(() =>
      codex.askUser({ type: 'confirm', question: 'OK' }),
    );
    assert.equal(val.value, true);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('codex-adapter: REGRESSION GUARD — does not import codex-toml or install-layer modules (D-20)', () => {
  const src = fs.readFileSync(require.resolve('./codex.cjs'), 'utf-8');
  assert.ok(
    !/codex-toml/.test(src),
    'D-20 violation: codex.cjs must not import lib/install/codex-toml.cjs — [features]-repair stays in install layer',
  );
  assert.ok(
    !/require\(['"]\.\.\/install\//.test(src),
    'codex.cjs must not reach into lib/install/',
  );
  assert.ok(
    !/repairCodexFeatures/.test(src),
    'codex.cjs must not reference repairCodexFeatures',
  );
});

test('codex-adapter: does not import node:readline directly', () => {
  const src = fs.readFileSync(require.resolve('./codex.cjs'), 'utf-8');
  assert.ok(
    !/require\(['"]node:readline['"]\)/.test(src),
    'codex.cjs must delegate to _readline.cjs',
  );
});

test('codex-adapter: exports runtimeNotice compatible with agents-md SC-5 check', () => {
  const notice = codex.runtimeNotice;
  assert.equal(typeof notice, 'string');
  assert.ok(notice.length > 0);
  assert.match(notice, /readline|prompt/i, 'runtimeNotice must match /readline|prompt/i');
});

test('codex-adapter: runtimeNotice starts with the runtime-hint marker (default fallback)', () => {
  assert.ok(codex.runtimeNotice.startsWith('> **Runtime-Hinweis:**'));
  assert.ok(/readline/.test(codex.runtimeNotice));
});

test('codex-adapter: runtimeNotice does not contain the forbidden joined Claude-tool literal (SC-5 guard)', () => {
  assert.ok(!/Ask-User-Question/.test(codex.runtimeNotice));
});

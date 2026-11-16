const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { _setReadlineImplForTests } = require('./_readline.cjs');
const oc = require('./opencode.cjs');

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stderr.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stderr.write = orig; throw err; },
  );
}

test('opencode-adapter: exports five-key contract', () => {
  for (const k of ['name', 'detectHints', 'capabilities', 'paths', 'askUser']) {
    assert.ok(k in oc, 'missing ' + k);
  }
  assert.equal(oc.name, 'opencode');
});

test('opencode-adapter: capabilities match D-07 + RESEARCH refinement', () => {
  const c = oc.capabilities;
  assert.equal(c.askUserQuestion, false);
  assert.equal(c.slashCommands, false);
  assert.equal(c.agentsMd, 'AGENTS.md');
  assert.equal(c.textMode, 'auto');
  assert.equal(
    c.modelResolution,
    'inherit',
    'RUN-02 RESEARCH: OpenCode inheritance is signaled by OMITTING model field; capability flag must read "inherit"',
  );
});

test('opencode-adapter: paths.config is project-root opencode.json (NOT .opencode/config.json)', () => {
  assert.equal(
    oc.paths.config,
    'opencode.json',
    'RESEARCH refinement of D-13: OpenCode config lives at project root as opencode.json',
  );
  assert.notEqual(oc.paths.config, '.opencode/config.json');
});

test('opencode-adapter: paths.payload and paths.agentsMd live under .opencode/nubos-pilot/ (8.1 D-02)', () => {
  assert.equal(oc.paths.payload, '.opencode/nubos-pilot/');
  assert.equal(oc.paths.agentsMd, '.opencode/nubos-pilot/AGENTS.md');
  assert.notEqual(oc.paths.agentsMd, '.opencode/AGENTS.md');
  assert.notEqual(oc.paths.payload, '.opencode/');
});

test('opencode-adapter: readline select parses 1-based index', async () => {
  _setReadlineImplForTests(async () => '2');
  try {
    const { val } = await captureStderr(() =>
      oc.askUser({ type: 'select', question: 'P', options: ['A', 'B', 'C'] }),
    );
    assert.equal(val.value, 'B');
    assert.equal(val.source, 'readline');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('opencode-adapter: readline multiselect parses comma-indices', async () => {
  _setReadlineImplForTests(async () => '1,3');
  try {
    const { val } = await captureStderr(() =>
      oc.askUser({ type: 'multiselect', question: 'P', options: ['A', 'B', 'C'] }),
    );
    assert.deepEqual(val.value, ['A', 'C']);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('opencode-adapter: input with injected line', async () => {
  _setReadlineImplForTests(async () => 'hello');
  try {
    const { val } = await captureStderr(() =>
      oc.askUser({ type: 'input', question: 'Q' }),
    );
    assert.equal(val.value, 'hello');
    assert.equal(val.source, 'readline');
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('opencode-adapter: confirm y/n', async () => {
  _setReadlineImplForTests(async () => 'n');
  try {
    const { val } = await captureStderr(() =>
      oc.askUser({ type: 'confirm', question: 'OK' }),
    );
    assert.equal(val.value, false);
  } finally {
    _setReadlineImplForTests(null);
  }
});

test('opencode-adapter: does not require install-layer modules (single responsibility)', () => {
  const src = fs.readFileSync(require.resolve('./opencode.cjs'), 'utf-8');
  assert.ok(
    !/require\(['"]\.\.\/install\//.test(src),
    'adapter must not reach into lib/install/ — install logic stays in install layer',
  );
});

test('opencode-adapter: exports runtimeNotice compatible with agents-md SC-5 check', () => {
  const notice = oc.runtimeNotice;
  assert.equal(typeof notice, 'string');
  assert.ok(notice.length > 0);
  assert.match(notice, /readline|prompt/i, 'runtimeNotice must match /readline|prompt/i');
});

test('opencode-adapter: runtimeNotice references .opencode/nubos-pilot/AGENTS.md (8.1 D-02)', () => {
  assert.ok(oc.runtimeNotice.includes('.opencode/nubos-pilot/AGENTS.md'));
});

test('opencode-adapter: runtimeNotice does not contain the forbidden joined Claude-tool literal (SC-5 guard)', () => {
  assert.ok(!/Ask-User-Question/.test(oc.runtimeNotice));
});

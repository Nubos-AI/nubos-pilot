const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listRuntimes, getAdapter } = require('./index.cjs');

const REQUIRED_KEYS = ['name', 'detectHints', 'capabilities', 'paths', 'askUser'];
const CAP_KEYS = ['askUserQuestion', 'slashCommands', 'agentsMd', 'textMode', 'modelResolution'];
const VALID_TEXT_MODE = ['auto', 'force', 'off'];
const VALID_MODEL_RES = ['explicit', 'inherit', 'profile'];
const VALID_AGENTS_MD = [
  null, 'AGENTS.md', 'GEMINI.md', 'CLAUDE.md',
  '.clinerules', '.windsurfrules',
  'rules/nubos-pilot.mdc', 'copilot-instructions.md',
];

for (const name of listRuntimes()) {
  test('RT-contract(' + name + '): exports all required keys', () => {
    const a = getAdapter(name);
    for (const k of REQUIRED_KEYS) {
      assert.ok(k in a, name + ' missing ' + k);
    }
    assert.equal(a.name, name);
  });

  test('RT-contract(' + name + '): capabilities shape valid', () => {
    const caps = getAdapter(name).capabilities;
    for (const k of CAP_KEYS) {
      assert.ok(k in caps, name + ' missing cap ' + k);
    }
    assert.equal(typeof caps.askUserQuestion, 'boolean');
    assert.equal(typeof caps.slashCommands, 'boolean');
    assert.ok(
      VALID_TEXT_MODE.includes(caps.textMode),
      name + ' bad textMode: ' + caps.textMode,
    );
    assert.ok(
      VALID_MODEL_RES.includes(caps.modelResolution),
      name + ' bad modelResolution: ' + caps.modelResolution,
    );
    assert.ok(
      VALID_AGENTS_MD.includes(caps.agentsMd),
      name + ' bad agentsMd: ' + caps.agentsMd,
    );
  });

  test('RT-contract(' + name + '): askUser is a function', () => {
    const a = getAdapter(name);
    assert.equal(typeof a.askUser, 'function');

  });

  test('RT-contract(' + name + '): detectHints shape valid', () => {
    const dh = getAdapter(name).detectHints;
    assert.ok(dh && typeof dh === 'object', name + ' detectHints not object');
    assert.ok(Array.isArray(dh.env), name + ' detectHints.env not array');
    assert.equal(typeof dh.pathBinary, 'string');
    assert.ok(Array.isArray(dh.diskMarkers), name + ' detectHints.diskMarkers not array');
  });
}

test('RT-contract: getAdapter throws on unknown runtime', () => {
  assert.throws(
    () => getAdapter('nonexistent'),
    (err) => err && err.code === 'runtime-unknown',
  );
});

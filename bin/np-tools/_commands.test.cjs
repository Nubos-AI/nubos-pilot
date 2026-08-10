const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMANDS } = require('./_commands.cjs');
const nt = require('../../np-tools.cjs');

const HARD_CASED = ['init', 'state', 'help'];

function dispatchNames() {
  return new Set([
    ...HARD_CASED,
    ...Object.keys(nt.initWorkflows),
    ...Object.keys(nt.topLevelCommands),
  ]);
}

function catalogNames() {
  return new Set(COMMANDS.map((c) => c.name));
}

test('CAT-DISPATCH-1: every catalog command has a dispatch entry', () => {
  const dispatch = dispatchNames();
  const orphans = [...catalogNames()].filter((n) => !dispatch.has(n));
  assert.deepEqual(orphans, [], 'catalog commands without a dispatch entry: ' + orphans.join(', '));
});

test('CAT-DISPATCH-2: every dispatch entry has a catalog command', () => {
  const catalog = catalogNames();
  const orphans = [...dispatchNames()].filter((n) => !catalog.has(n));
  assert.deepEqual(orphans, [], 'dispatch entries without a catalog command: ' + orphans.join(', '));
});

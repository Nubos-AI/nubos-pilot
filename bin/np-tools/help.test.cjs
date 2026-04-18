const test = require('node:test');
const assert = require('node:assert/strict');

const helpCmd = require('./help.cjs');

test('HELP-CMD-1: run([]) returns rendered text grouped by category with all 5 names', () => {
  const out = helpCmd.run([]);
  assert.ok(out && typeof out.text === 'string');
  for (const name of ['next', 'progress', 'state', 'help', 'init']) {
    assert.match(out.text, new RegExp('\\b' + name + '\\b'));
  }
});

test('HELP-CMD-2: run([--json]) returns { commands: [...] } with all registered entries', () => {
  const out = helpCmd.run(['--json']);
  assert.ok(Array.isArray(out.commands));

  
  const names = out.commands.map((c) => c.name);
  for (const n of ['help', 'init', 'next', 'progress', 'state']) {
    assert.ok(names.includes(n), 'expected utility command: ' + n);
  }
  const planning = out.commands.filter((c) => c.category === 'Planning');
  assert.ok(planning.length >= 8, 'expected ≥8 Planning commands, got ' + planning.length);
  for (const c of out.commands) {
    assert.ok(typeof c.category === 'string' && c.category.length > 0);
    assert.ok(typeof c.description === 'string' && c.description.length > 0);
  }
});

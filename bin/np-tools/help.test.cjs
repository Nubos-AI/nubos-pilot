const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpCmd = require('./help.cjs');

function _sandbox(language) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-help-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (language !== undefined) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ response_language: language }),
      'utf-8',
    );
  }
  return root;
}

test('HELP-CMD-1: run([]) returns rendered text grouped by category with base command names', () => {
  const out = helpCmd.run([]);
  assert.ok(out && typeof out.text === 'string');
  for (const name of ['state', 'help', 'init']) {
    assert.match(out.text, new RegExp('\\b' + name + '\\b'));
  }
});

test('HELP-CMD-2: run([--json]) returns { commands: [...] } with all registered entries', () => {
  const out = helpCmd.run(['--json']);
  assert.ok(Array.isArray(out.commands));
  const names = out.commands.map((c) => c.name);
  for (const n of ['help', 'init', 'state']) {
    assert.ok(names.includes(n), 'expected utility command: ' + n);
  }
  const planning = out.commands.filter((c) => c.category === 'Planning');
  assert.ok(planning.length >= 5, 'expected ≥5 Planning commands, got ' + planning.length);
  for (const c of out.commands) {
    assert.ok(typeof c.category === 'string' && c.category.length > 0);
    assert.ok(typeof c.description === 'string' && c.description.length > 0);
  }
});

test('HELP-L1: text render uses German category labels when config.response_language=de', () => {
  const root = _sandbox('de');
  try {
    const out = helpCmd.run([], { cwd: root });
    assert.match(out.text, /^Werkzeuge\b/m);
    assert.match(out.text, /^Planung\b/m);
    assert.match(out.text, /^Ausführung\b/m);
    assert.equal(/^Utility\b/m.test(out.text), false, 'must not show English category in de mode');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HELP-L2: text render uses German command descriptions when config language=de', () => {
  const root = _sandbox('de');
  try {
    const out = helpCmd.run([], { cwd: root });
    assert.match(out.text, /Listet verfügbare Commands auf/);
    assert.match(out.text, /Gibt aktuellen Projekt-State-Snapshot aus/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HELP-L3: --json descriptions are localized but category stays canonical English key', () => {
  const root = _sandbox('de');
  try {
    const out = helpCmd.run(['--json'], { cwd: root });
    const help = out.commands.find((c) => c.name === 'help');
    assert.equal(help.description, 'Listet verfügbare Commands auf');
    assert.equal(help.category, 'Utility', 'category stays English so consumers can switch on it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HELP-L4: missing config falls back to English', () => {
  const root = _sandbox();
  try {
    const out = helpCmd.run([], { cwd: root });
    assert.match(out.text, /^Utility\b/m);
    assert.match(out.text, /List available commands/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

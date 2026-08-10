const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, cleanupAll } = require('../../tests/helpers/fixture.cjs');
const subcmd = require('./agent-skills.cjs');

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

afterEach(cleanupAll);

test('AS-1: run([name]) prints JSON.stringify(getAgentSkills(name))', () => {
  const sandbox = makeSandbox();
  fs.writeFileSync(
    path.join(sandbox, '.nubos-pilot', 'config.json'),
    JSON.stringify({ agent_skills: { 'np-planner': ['s1', 's2'] } }),
    'utf-8',
  );
  const cap = _capture();
  subcmd.run(['np-planner'], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.deepEqual(JSON.parse(out), ['s1', 's2']);
});

test('AS-2: run([]) prints {} (empty usage response)', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  assert.equal(cap.get().trim(), '{}');
});

test('AS-3: run([nonexistent]) prints [] (never throws)', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.doesNotThrow(() => subcmd.run(['nobody'], { cwd: sandbox, stdout: cap.stub }));
  assert.equal(cap.get().trim(), '[]');
});

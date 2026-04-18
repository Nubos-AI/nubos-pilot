const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./pause-work.cjs');

const _roots = [];

function makeRoot(currentTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pw-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const ct = currentTask == null ? 'null' : currentTask;
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: 6
current_plan: "06-01"
current_task: ${ct}
last_updated: "2026-04-15T00:00:00Z"
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
session:
  stopped_at: null
  resume_file: null
  last_activity: null
---

# State
`, 'utf-8');
  _roots.push(root);
  return root;
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; return true; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('PW-1: pause-work sets stopped_at and resume_file when current_task set', () => {
  const root = makeRoot('06-01-T01');
  const cap = _capture();
  const p = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(p.ok, true);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(p.stopped_at));
  assert.equal(p.resume_file, '.nubos-pilot/checkpoints/06-01-T01.json');
});

test('PW-2: pause-work resume_file=null when no current_task', () => {
  const root = makeRoot(null);
  const cap = _capture();
  const p = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(p.resume_file, null);
  assert.ok(p.stopped_at);
});

test('PW-3: STATE.md on disk reflects the mutation', () => {
  const root = makeRoot('06-01-T02');
  const cap = _capture();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const body = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.ok(/stopped_at: "?\d{4}-\d{2}-\d{2}T/.test(body), body);
  assert.ok(body.includes('resume_file: .nubos-pilot/checkpoints/06-01-T02.json'), body);
});

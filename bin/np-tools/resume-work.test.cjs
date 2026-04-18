const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./resume-work.cjs');
const { startTask } = require('../../lib/checkpoint.cjs');

const _roots = [];

function makeRoot(currentTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rw-'));
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

test('RW-1: clean when no state, no checkpoints', () => {
  const root = makeRoot(null);
  const cap = _capture();
  const p = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(p.status, 'clean');
});

test('RW-2: resume when current_task matches an in-progress checkpoint', () => {
  const root = makeRoot('06-01-T01');
  startTask({ id: '06-01-T01', phase: 6, plan: '06-01', wave: 1 }, root);
  const cap = _capture();
  const p = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(p.status, 'resume');
  assert.equal(p.task_id, '06-01-T01');
  assert.equal(p.checkpoint.status, 'in-progress');
});

test('RW-3: orphan when checkpoint files exist but no matching STATE.current_task', () => {
  const root = makeRoot(null);
  startTask({ id: '06-01-T05', phase: 6, plan: '06-01', wave: 1 }, root);

  const statePath = path.join(root, '.nubos-pilot', 'STATE.md');
  const body = fs.readFileSync(statePath, 'utf-8').replace(/current_task:.*/, 'current_task: null');
  fs.writeFileSync(statePath, body, 'utf-8');
  const cap = _capture();
  const p = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(p.status, 'orphan');
  assert.ok(p.checkpoint_ids.includes('06-01-T05'));
});

test('RW-4: malformed checkpoint → checkpoint-schema-mismatch (T-06-12)', () => {
  const root = makeRoot('06-01-T09');
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(path.join(cpDir, '06-01-T09.json'), JSON.stringify({ schema_version: 99, task_id: '06-01-T09' }), 'utf-8');
  const cap = _capture();
  assert.throws(
    () => subcmd.run([], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'checkpoint-schema-mismatch',
  );
});

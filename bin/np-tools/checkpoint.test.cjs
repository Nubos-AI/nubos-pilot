const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./checkpoint.cjs');

const _roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cp-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: null
current_plan: null
current_task: null
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

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CPT-1: checkpoint start writes file and updates STATE.current_task', () => {
  const root = makeRoot();
  const cap = _capture();
  subcmd.run(['start', 'M006-S001-T0001', '--phase', '6', '--plan', '06-01', '--wave', '1'], { cwd: root, stdout: cap.stub });
  const cp = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0001.json'), 'utf-8'));
  assert.equal(cp.task_id, 'M006-S001-T0001');
  assert.equal(cp.status, 'in-progress');
  const state = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.ok(state.includes('current_task: M006-S001-T0001'), state);
});

test('CPT-2: checkpoint transition updates status', () => {
  const root = makeRoot();
  const cap = _capture();
  subcmd.run(['start', 'M006-S001-T0002', '--phase', '6', '--plan', '06-01', '--wave', '1'], { cwd: root, stdout: cap.stub });
  subcmd.run(['transition', 'M006-S001-T0002', 'verifying'], { cwd: root, stdout: cap.stub });
  const cp = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0002.json'), 'utf-8'));
  assert.equal(cp.status, 'verifying');
});

test('CPT-3: checkpoint transition rejects unknown status', () => {
  const root = makeRoot();
  const cap = _capture();
  subcmd.run(['start', 'M006-S001-T0003', '--phase', '6', '--plan', '06-01', '--wave', '1'], { cwd: root, stdout: cap.stub });
  assert.throws(
    () => subcmd.run(['transition', 'M006-S001-T0003', 'weird'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'checkpoint-invalid-status',
  );
});

test('CPT-4: checkpoint touch appends to files_touched', () => {
  const root = makeRoot();
  const cap = _capture();
  subcmd.run(['start', 'M006-S001-T0004', '--phase', '6', '--plan', '06-01', '--wave', '1'], { cwd: root, stdout: cap.stub });
  subcmd.run(['touch', 'M006-S001-T0004', 'src/a.ts'], { cwd: root, stdout: cap.stub });
  subcmd.run(['touch', 'M006-S001-T0004', 'src/b.ts'], { cwd: root, stdout: cap.stub });
  const cp = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0004.json'), 'utf-8'));
  assert.deepEqual(cp.files_touched, ['src/a.ts', 'src/b.ts']);
});

test('CPT-5: checkpoint show emits JSON', () => {
  const root = makeRoot();
  const cap1 = _capture();
  subcmd.run(['start', 'M006-S001-T0005', '--phase', '6', '--plan', '06-01', '--wave', '1'], { cwd: root, stdout: cap1.stub });
  const cap2 = _capture();
  subcmd.run(['show', 'M006-S001-T0005'], { cwd: root, stdout: cap2.stub });
  const json = JSON.parse(cap2.get());
  assert.equal(json.task_id, 'M006-S001-T0005');
});

test('CPT-6: unknown verb throws', () => {
  const root = makeRoot();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bogus', 'M006-S001-T0001'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'checkpoint-unknown-verb',
  );
});

test('CPT-7: invalid task-id format rejected (defense-in-depth)', () => {
  const root = makeRoot();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['start', 'not-a-task-id'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
});

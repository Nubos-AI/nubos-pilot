const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./reset-slice.cjs');

const _roots = [];

function makeProject(currentTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-reset-'));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const ct = currentTask == null ? 'null' : currentTask;
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: M006
milestone_name: demo
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

function seedTask(root, taskId, files) {
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  const body = [
    '---', `id: ${taskId}`, `milestone: ${mId}`, `slice: ${mId}-${sId}`, 'type: execute',
    'status: in-progress', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified:',
    ...files.map((f) => `  - ${f}`),
    'autonomous: true', 'must_haves:', '  truths: []', '---', '', '# T',
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), body, 'utf-8');
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('RS-1: invalid task id argument throws reset-slice-invalid-task-id', () => {
  const root = makeProject(null);
  assert.throws(
    () => subcmd.run(['nope'], { cwd: root, stdout: _capture().stub }),
    (err) => err && err.code === 'reset-slice-invalid-task-id',
  );
});

test('RS-2: no current_task + no checkpoints → clean no-op', () => {
  const root = makeProject(null);
  const cap = _capture();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, null);
  assert.deepEqual(payload.deleted_checkpoints, []);
});

test('RS-3: in-flight task restores working tree + drops checkpoint + clears STATE', () => {
  const root = makeProject('M006-S001-T0001');
  seedTask(root, 'M006-S001-T0001', ['src/mod.ts']);

  // Commit baseline for src/mod.ts so there's something to restore to.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'mod.ts'), 'export const original = 1;\n');
  execFileSync('git', ['-C', root, 'add', '--', 'src/mod.ts'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'baseline'], { stdio: 'pipe' });

  // Simulate in-progress edit + checkpoint.
  fs.writeFileSync(path.join(root, 'src', 'mod.ts'), 'export const mutated = 1;\n');
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(path.join(cpDir, 'M006-S001-T0001.json'), JSON.stringify({
    task_id: 'M006-S001-T0001', status: 'in-progress', milestone: 6, slice: 1,
  }));

  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    subcmd.run([], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.ok, true);
    assert.equal(payload.task_id, 'M006-S001-T0001');
    assert.deepEqual(payload.restored_files, ['src/mod.ts']);

    // Working tree restored to HEAD
    assert.equal(fs.readFileSync(path.join(root, 'src', 'mod.ts'), 'utf-8'), 'export const original = 1;\n');

    // Checkpoint dropped
    assert.equal(fs.existsSync(path.join(cpDir, 'M006-S001-T0001.json')), false);

    // STATE.current_task cleared
    const state = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
    assert.match(state, /^current_task:\s*null$/m);
  } finally {
    process.chdir(prev);
  }
});

test('RS-4: explicit task id arg overrides STATE.current_task', () => {
  const root = makeProject(null);
  seedTask(root, 'M006-S001-T0005', ['src/b.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'x');
  execFileSync('git', ['-C', root, 'add', '--', 'src/b.ts'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'baseline'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'dirty');

  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    subcmd.run(['M006-S001-T0005'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.task_id, 'M006-S001-T0005');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf-8'), 'x');
  } finally {
    process.chdir(prev);
  }
});

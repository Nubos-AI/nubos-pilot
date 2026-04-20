const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./commit-task.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ct-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
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
  _repos.push(root);
  return root;
}

function seedPlanAndTask(root, planId, taskId, filesModified) {
  // planId format: M006-S001 (ignored param compat); taskId: M006-S001-T0001
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  if (!m) throw new Error('bad taskId: ' + taskId);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });

  const fm = [
    '---',
    `id: ${taskId}`,
    `milestone: ${mId}`,
    `slice: ${mId}-${sId}`,
    'type: execute',
    'status: in-progress',
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified:',
    ...filesModified.map((f) => `  - ${f}`),
    'autonomous: true',
    'must_haves:',
    '  truths: []',
    '---',
    '',
    '# Task: demo',
  ].join('\n');
  const taskPath = path.join(taskDir, tId + '-PLAN.md');
  fs.writeFileSync(taskPath, fm, 'utf-8');
  return { taskDir, taskPath };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CT-1: commit-task requires a task id', () => {
  const root = makeRepo();
  const cap = _capture();
  assert.throws(
    () => subcmd.run([], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'commit-task-missing-id',
  );
});

test('CT-2: commit-task rejects invalid TASK_ID format (defense-in-depth)', () => {
  const root = makeRepo();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bad/id'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'commit-task-invalid-id',
  );
});

test('CT-3: commit-task emits JSON with sha + files on success', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0001', ['src/a.ts']);

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run(['M006-S001-T0001'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, 'M006-S001-T0001');
  assert.ok(/^[0-9a-f]{40}$/.test(payload.sha));
  assert.deepEqual(payload.files, ['src/a.ts']);

  const subject = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
  assert.ok(subject.startsWith('task(M006-S001-T0001):'), 'subject: ' + subject);
});

test('CT-4: commit-task LOUD-FAILS when every files_modified entry is gitignored (D-25)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0002', ['build/out.js']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'noise', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    assert.throws(
      () => subcmd.run(['M006-S001-T0002'], { cwd: root, stdout: cap.stub }),
      (err) => err && err.code === 'commit-all-paths-gitignored',
    );
  } finally {
    process.chdir(prev);
  }
});

test('CT-5: commit-task unknown task id → task-not-found', () => {
  const root = makeRepo();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['M006-S099-T0099'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'commit-task-not-found',
  );
});

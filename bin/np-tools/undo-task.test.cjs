const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./undo-task.cjs');
const git = require('../../lib/git.cjs');

const _roots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-undotask-'));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'init'], { stdio: 'pipe' });
  _roots.push(root);
  return root;
}

function seedTask(root, taskId) {
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), [
    '---', `id: ${taskId}`, `milestone: ${mId}`, `slice: ${mId}-${sId}`, 'type: execute',
    'status: done', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified:', '  - src/a.ts', 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# Task',
  ].join('\n'), 'utf-8');
  return path.join(taskDir, tId + '-PLAN.md');
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('UT-1: missing task id throws undo-task-missing-id', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-task-missing-id',
  );
});

test('UT-2: invalid task id throws undo-task-invalid-id', () => {
  assert.throws(
    () => subcmd.run(['bad'], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-task-invalid-id',
  );
});

test('UT-3: commit-not-found when no task commit matches', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () => subcmd.run(['M006-S001-T0099'], { cwd: root, stdout: _capture().stub }),
      (err) => err && err.code === 'undo-task-commit-not-found',
    );
  } finally {
    process.chdir(prev);
  }
});

test('UT-4: undo-task reverts commit, emits sha, resets status', () => {
  const root = makeRepo();
  const taskFile = seedTask(root, 'M006-S001-T0001');
  const prev = process.cwd();
  process.chdir(root);
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git.commitTask('M006-S001-T0001', ['src/a.ts'], 'task(M006-S001-T0001): add a');

    const cap = _capture();
    subcmd.run(['M006-S001-T0001'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.ok, true);
    assert.equal(payload.task_id, 'M006-S001-T0001');
    assert.match(payload.reverted_sha, /^[0-9a-f]{40}$/);
    assert.equal(payload.status, 'pending');

    // Working tree reflects the revert
    assert.equal(fs.existsSync(path.join(root, 'src', 'a.ts')), false);

    // Task frontmatter flipped back to pending
    assert.match(fs.readFileSync(taskFile, 'utf-8'), /^status: pending$/m);

    // Original commit still exists + new revert commit on top
    const subjects = execFileSync('git', ['-C', root, 'log', '--format=%s'], { encoding: 'utf-8' })
      .trim().split('\n');
    assert.ok(subjects[0].startsWith('Revert "task(M006-S001-T0001)'), 'newest commit is revert');
    assert.ok(subjects.some((s) => s === 'task(M006-S001-T0001): add a'), 'original commit preserved');
  } finally {
    process.chdir(prev);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const subcmd = require('./undo-task.cjs');
const git = require('../../lib/git.cjs');

const { makeRepo, seedTask: seedTaskFixture, captureOutput: _capture } = require('../../lib/__tests__/fixtures.cjs');

function seedTask(root, taskId) {
  return seedTaskFixture(root, taskId, { files: ['src/a.ts'] });
}

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

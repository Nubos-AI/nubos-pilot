const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const subcmd = require('./undo.cjs');
const git = require('../../lib/git.cjs');

const { makeRepo, seedTask, captureOutput: _capture } = require('../../lib/__tests__/fixtures.cjs');

function commitTask(root, taskId, file) {
  fs.writeFileSync(path.join(root, file), 'x');
  git.commitTask(taskId, [file], 'task(' + taskId + '): add ' + file);
}

test('UN-1: missing prefix throws undo-missing-prefix', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-missing-prefix',
  );
});

test('UN-2: invalid prefix throws undo-invalid-prefix', () => {
  assert.throws(
    () => subcmd.run(['bad-prefix'], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-invalid-prefix',
  );
});

test('UN-3: milestone number accepted and padded to M<NNN>', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    subcmd.run(['1'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.prefix, 'M001');
    assert.deepEqual(payload.reverted, []);
  } finally {
    process.chdir(prev);
  }
});

test('UN-4: reverts every task commit under a milestone and flips statuses', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    seedTask(root, 'M006-S001-T0001');
    seedTask(root, 'M006-S001-T0002');
    commitTask(root, 'M006-S001-T0001', 'a.ts');
    commitTask(root, 'M006-S001-T0002', 'b.ts');

    const cap = _capture();
    subcmd.run(['6'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.ok, true);
    assert.equal(payload.prefix, 'M006');
    assert.equal(payload.count, 2);

    // Working tree: both files gone
    assert.equal(fs.existsSync(path.join(root, 'a.ts')), false);
    assert.equal(fs.existsSync(path.join(root, 'b.ts')), false);

    // Both task frontmatters reset
    const t1 = path.join(root, '.nubos-pilot', 'milestones', 'M006', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md');
    const t2 = path.join(root, '.nubos-pilot', 'milestones', 'M006', 'slices', 'S001', 'tasks', 'T0002', 'T0002-PLAN.md');
    assert.match(fs.readFileSync(t1, 'utf-8'), /^status: pending$/m);
    assert.match(fs.readFileSync(t2, 'utf-8'), /^status: pending$/m);
  } finally {
    process.chdir(prev);
  }
});

test('UN-5: slice full-id narrows to one slice only', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    seedTask(root, 'M006-S001-T0001');
    seedTask(root, 'M006-S002-T0001');
    commitTask(root, 'M006-S001-T0001', 'a.ts');
    commitTask(root, 'M006-S002-T0001', 'b.ts');

    const cap = _capture();
    subcmd.run(['M006-S002'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.count, 1);
    assert.equal(payload.reverted[0].task_id, 'M006-S002-T0001');

    // Slice S001 untouched — file still present
    assert.equal(fs.existsSync(path.join(root, 'a.ts')), true);
    // Slice S002 reverted
    assert.equal(fs.existsSync(path.join(root, 'b.ts')), false);
  } finally {
    process.chdir(prev);
  }
});

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./undo.cjs');
const git = require('../../lib/git.cjs');

const _roots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-undo-'));
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
    'depends_on: []', 'files_modified: []', 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# Task',
  ].join('\n'), 'utf-8');
}

function commitTask(root, taskId, file) {
  fs.writeFileSync(path.join(root, file), 'x');
  git.commitTask(taskId, [file], 'task(' + taskId + '): add ' + file);
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

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

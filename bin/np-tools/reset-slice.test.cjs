const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./reset-slice.cjs');

const _roots = [];

// Tests that rely on POSIX permission enforcement (chmod) are unreliable
// when the runner is root (Forgejo docker container), since root bypasses
// read/write permission checks. Skip them in that environment.
const _isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const testPerm = _isRoot ? test.skip : test;

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

test('RS-2b: no current_task → orphan checkpoint files are actually deleted (P3.1)', () => {
  const root = makeProject(null);
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  const orphan = path.join(cpDir, 'M006-S001-T0001.json');
  fs.writeFileSync(orphan, JSON.stringify({ task_id: 'M006-S001-T0001', phase: 'executing' }), 'utf-8');

  const cap = _capture();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());

  // The defect: listCheckpoints yields path strings, so cp.task_id was undefined,
  // deleteCheckpoint threw, an empty catch swallowed it, and the payload still
  // claimed "cleared 1 orphan checkpoint(s)" with deleted_checkpoints: [null].
  assert.ok(!fs.existsSync(orphan), 'the orphan checkpoint file must be gone from disk');
  assert.deepEqual(payload.deleted_checkpoints, ['M006-S001-T0001']);
  assert.match(payload.message, /cleared 1 orphan/);
});

test('RS-2c: no current_task → a non-checkpoint file is left alone, not claimed as deleted (P3.1)', () => {
  const root = makeProject(null);
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  const stray = path.join(cpDir, 'notes.json');
  fs.writeFileSync(stray, '{}', 'utf-8');

  const cap = _capture();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());

  assert.ok(fs.existsSync(stray), 'a file that is not a task checkpoint must not be deleted');
  assert.deepEqual(payload.deleted_checkpoints, []);
  assert.deepEqual(payload.skipped_checkpoints, ['notes']);
  assert.match(payload.message, /cleared 0 orphan/);
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

// ---------------------------------------------------------------------------
// The tests above pass because they chdir into the very repo they target, so a
// cwd-less git call accidentally lands right. The real topology is a slice
// worktree NESTED inside the main repo at <repo>/.nubos-pilot/worktrees/M/S.
// ---------------------------------------------------------------------------

function makeNestedWorktree(root, sliceFullId) {
  const m = sliceFullId.match(/^(M\d{3,})-(S\d{3,})$/);
  const wt = path.join(root, '.nubos-pilot', 'worktrees', m[1], m[2]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'np/' + sliceFullId, wt], {
    stdio: 'pipe',
  });
  return wt;
}

test('RS-5: reset-slice --cwd <worktree> must NOT destroy uncommitted user work in the main repo', () => {
  const root = makeProject(null);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  execFileSync('git', ['-C', root, 'add', '--', 'src/a.ts'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'baseline'], { stdio: 'pipe' });

  const wt = makeNestedWorktree(root, 'M001-S001');
  // The plan is reachable from BOTH trees (a worktree is a checkout of the same
  // repo), which is exactly why a cwd-less `git restore` lands on the wrong one
  // instead of failing loudly.
  seedTask(root, 'M001-S001-T0001', ['src/a.ts']);
  seedTask(wt, 'M001-S001-T0001', ['src/a.ts']);

  // Uncommitted USER change in the main repo — Working-Tree is Userland.
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1; // UNCOMMITTED USER CHANGE\n');
  // In-flight task work inside the slice worktree — this is what gets discarded.
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 999; // WORKTREE WORK\n');

  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    subcmd.run(['M001-S001-T0001', '--cwd', wt, '--keep-worktree'], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.restored_files, ['src/a.ts']);
  } finally {
    process.chdir(prev);
  }

  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8'),
    'export const a = 1; // UNCOMMITTED USER CHANGE\n',
    'the uncommitted user change in the MAIN repo must survive reset-slice --cwd <worktree>',
  );
  assert.equal(
    fs.readFileSync(path.join(wt, 'src', 'a.ts'), 'utf-8'),
    'export const a = 2;\n',
    'the targeted worktree is the one restored to HEAD',
  );
});

test('RS-6: restoreFiles failure must not be reported as restored_files (payload truth)', () => {
  const root = makeProject('M006-S001-T0001');
  // files_modified names a path git cannot restore -> `git restore` exits non-zero.
  seedTask(root, 'M006-S001-T0001', ['src/never-tracked.ts']);

  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    const payload = subcmd.run([], { cwd: root, stdout: cap.stub });
    assert.equal(payload.ok, false, 'a failed restore must not report ok:true');
    assert.deepEqual(payload.restored_files, [], 'nothing was restored, so claim nothing');
    assert.ok(
      payload.errors.some((e) => e.code === 'reset-slice-restore-failed'),
      'the failure must be visible in the payload, not only in a log line',
    );
    assert.doesNotMatch(payload.message, /working tree restored to HEAD/);
  } finally {
    process.chdir(prev);
  }
});

test('RS-7: deleted_checkpoints reports actual unlinks, not the candidate list', () => {
  const root = makeProject('M006-S001-T0001');
  seedTask(root, 'M006-S001-T0001', []);
  // No checkpoint file was ever written: finishTask swallows ENOENT, so the old
  // payload still claimed deleted_checkpoints: ["M006-S001-T0001"].
  const prev = process.cwd();
  process.chdir(root);
  try {
    const cap = _capture();
    const payload = subcmd.run([], { cwd: root, stdout: cap.stub });
    assert.deepEqual(payload.deleted_checkpoints, [], 'no checkpoint existed, so none was deleted');
    assert.equal(payload.ok, true, 'a missing checkpoint is not an error, just not a deletion');
  } finally {
    process.chdir(prev);
  }
});

test('RS-8: an undeletable orphan is reported, not claimed as deleted, and does not abort the sweep', () => {
  const root = makeProject(null);
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  // A DIRECTORY named like a checkpoint: unlinkSync throws raw EPERM/EISDIR.
  // It sorts before the real orphan, so the old loop died before reaching it:
  // partial deletion, no payload, no NubosPilotError taxonomy.
  fs.mkdirSync(path.join(cpDir, 'M003-S001-T0003.json'), { recursive: true });
  const real = path.join(cpDir, 'M006-S001-T0001.json');
  fs.writeFileSync(real, JSON.stringify({ task_id: 'M006-S001-T0001' }), 'utf-8');

  const cap = _capture();
  const payload = subcmd.run([], { cwd: root, stdout: cap.stub });

  assert.ok(!fs.existsSync(real), 'the deletable orphan must still be swept');
  assert.deepEqual(payload.deleted_checkpoints, ['M006-S001-T0001']);
  assert.deepEqual(payload.failed_checkpoints.map((f) => f.task_id), ['M003-S001-T0003']);
  assert.equal(payload.ok, false);
  const err = payload.errors.find((e) => e.code === 'reset-slice-checkpoint-delete-failed');
  assert.ok(err, 'the failure needs a NubosPilotError code');
  assert.doesNotMatch(JSON.stringify(payload), /np-reset-/, 'errors must stay basename-only, no abs paths');
});

testPerm('RS-9: listCheckpoints failure must throw, not be reported as "cleared 0 orphan"', () => {
  const root = makeProject(null);
  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  fs.chmodSync(cpDir, 0o000);
  try {
    assert.throws(
      () => subcmd.run([], { cwd: root, stdout: _capture().stub }),
      (err) => err && err.code === 'reset-slice-checkpoint-list-failed',
      'an unreadable checkpoint dir is not an empty checkpoint dir',
    );
  } finally {
    fs.chmodSync(cpDir, 0o700);
  }
});

test('RS-10: worktree probe failure is surfaced, not swallowed into worktree_removed:null', () => {
  const root = makeProject('M006-S001-T0001');
  // Not a git repo: hasSliceWorktree throws worktree-not-git-repo. The old
  // `catch { exists = false; }` turned that into "no worktree here, nothing to do".
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ workflow: { worktree_isolation: true } }),
    'utf-8',
  );

  const cap = _capture();
  const payload = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(payload.ok, false);
  assert.ok(
    payload.errors.some((e) => e.code === 'reset-slice-worktree-probe-failed'),
    'a failing worktree probe must be distinguishable from "no worktree present"',
  );
});

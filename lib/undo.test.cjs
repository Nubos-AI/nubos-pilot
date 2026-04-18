const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const undo = require('./undo.cjs');
const git = require('./git.cjs');
const cp = require('./checkpoint.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-undo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: 6
current_plan: "06-01"
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

function seedTask(root, planId, taskId, filesModified) {
  const phase = planId.slice(0, 2);
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', phase + '-demo');
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const fm = [
    '---',
    `id: ${taskId}`,
    `phase: ${Number(phase)}`,
    `plan: "${planId}"`,
    'type: auto',
    'status: done',
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
  fs.writeFileSync(path.join(tasksDir, taskId + '.md'), fm, 'utf-8');
  return { phaseDir, planDir: phaseDir };
}

function commitFor(root, taskId, files) {
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'content for ' + taskId + ' in ' + f, 'utf-8');
  }
  const prev = process.cwd();
  process.chdir(root);
  try {
    git.commitTask(taskId, files, 'task(' + taskId + '): demo');
  } finally {
    process.chdir(prev);
  }
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('UN-1: undoTask reverts the commit and resets task status to pending', () => {
  const root = makeRepo();
  seedTask(root, '06-01', '06-01-T01', ['src/a.ts']);
  const prev = process.cwd();
  process.chdir(root);
  try {
    commitFor(root, '06-01-T01', ['src/a.ts']);
    const before = execFileSync('git', ['log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').length;
    const result = undo.undoTask('06-01-T01', root);
    assert.equal(result.task_id, '06-01-T01');
    assert.ok(/^[0-9a-f]{40}$/.test(result.reverted_sha));
    const after = execFileSync('git', ['log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').length;
    assert.equal(after, before + 1, 'a new revert commit should exist');

    const taskFile = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks', '06-01-T01.md');
    assert.match(fs.readFileSync(taskFile, 'utf-8'), /^status: pending$/m);
  } finally {
    process.chdir(prev);
  }
});

test('UN-2: undoTask with malicious task-id format → task-commit-not-found (T-06-17)', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () => undo.undoTask('06-99; rm -rf /', root),
      (err) => err && err.code === 'task-commit-not-found',
    );
  } finally {
    process.chdir(prev);
  }
});

test('UN-3: resetSlice restores files_touched, deletes checkpoint, resets task status', () => {
  const root = makeRepo();
  seedTask(root, '06-01', '06-01-T03', ['src/c.ts']);

  const abs = path.join(root, 'src', 'c.ts');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'baseline\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    execFileSync('git', ['add', 'src/c.ts'], { stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'baseline', '-q'], { stdio: 'pipe' });

    cp.startTask({ id: '06-01-T03', phase: 6, plan: '06-01', wave: 1 }, root);
    cp.writeCheckpoint('06-01-T03', { files_touched: ['src/c.ts'] }, root);

    fs.writeFileSync(abs, 'dirty work\n', 'utf-8');
    const result = undo.resetSlice(root);
    assert.equal(result.task_id, '06-01-T03');
    assert.deepEqual(result.restored_paths, ['src/c.ts']);

    assert.equal(fs.readFileSync(abs, 'utf-8'), 'baseline\n');

    assert.equal(cp.readCheckpoint('06-01-T03', root), null);

    const stateBody = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
    assert.match(stateBody, /current_task: null/);

    const taskFile = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks', '06-01-T03.md');
    assert.match(fs.readFileSync(taskFile, 'utf-8'), /^status: pending$/m);
  } finally {
    process.chdir(prev);
  }
});

test('UN-4: resetSlice with no current_task → undo-dirty-tree', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () => undo.resetSlice(root),
      (err) => err && err.code === 'undo-dirty-tree',
    );
  } finally {
    process.chdir(prev);
  }
});

test('UN-5: resetSlice with current_task but no checkpoint → checkpoint-orphan', () => {
  const root = makeRepo();

  const sp = path.join(root, '.nubos-pilot', 'STATE.md');
  const body = fs.readFileSync(sp, 'utf-8').replace(/current_task: null/, 'current_task: "06-01-T07"');
  fs.writeFileSync(sp, body, 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () => undo.resetSlice(root),
      (err) => err && err.code === 'checkpoint-orphan',
    );
  } finally {
    process.chdir(prev);
  }
});

test('UN-6: undoPlan reverts all task commits in reverse chronological order', () => {
  const root = makeRepo();
  seedTask(root, '06-01', '06-01-T01', ['src/p1.ts']);
  seedTask(root, '06-01', '06-01-T02', ['src/p2.ts']);
  seedTask(root, '06-01', '06-01-T03', ['src/p3.ts']);
  const prev = process.cwd();
  process.chdir(root);
  try {
    commitFor(root, '06-01-T01', ['src/p1.ts']);
    commitFor(root, '06-01-T02', ['src/p2.ts']);
    commitFor(root, '06-01-T03', ['src/p3.ts']);
    const result = undo.undoPlan('06-01', root);
    assert.equal(result.reverted.length, 3);

    const revertCount = execFileSync('git', ['log', '--grep=^Revert', '--format=%H'], { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean).length;
    assert.equal(revertCount, 3);

    for (const id of ['06-01-T01', '06-01-T02', '06-01-T03']) {
      const tf = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks', id + '.md');
      assert.match(fs.readFileSync(tf, 'utf-8'), /^status: pending$/m, id);
    }
  } finally {
    process.chdir(prev);
  }
});

test('UN-7: undoPlan with nothing committed → emit nothing-to-revert', () => {
  const root = makeRepo();
  const prev = process.cwd();
  process.chdir(root);
  try {
    const result = undo.undoPlan('06-99', root);
    assert.deepEqual(result.reverted, []);
    assert.equal(result.message, 'nothing to revert');
  } finally {
    process.chdir(prev);
  }
});

test('UN-8: undoPhase reverts all plans of the phase', () => {
  const root = makeRepo();
  seedTask(root, '06-01', '06-01-T01', ['src/q1.ts']);
  seedTask(root, '06-02', '06-02-T01', ['src/q2.ts']);
  const prev = process.cwd();
  process.chdir(root);
  try {
    commitFor(root, '06-01-T01', ['src/q1.ts']);
    commitFor(root, '06-02-T01', ['src/q2.ts']);
    const result = undo.undoPhase(6, root);
    assert.equal(result.reverted.length, 2);
  } finally {
    process.chdir(prev);
  }
});

test('UN-9: exports', () => {
  assert.equal(typeof undo.undoTask, 'function');
  assert.equal(typeof undo.undoPlan, 'function');
  assert.equal(typeof undo.undoPhase, 'function');
  assert.equal(typeof undo.resetSlice, 'function');
});

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { startTask, listCheckpoints } = require('./checkpoint.cjs');
const { reconcileCommittedCheckpoints, committedSha } = require('./checkpoint-reconcile.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cr-'));
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

function commitFor(root, taskId) {
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', `task(${taskId}): demo`], { stdio: 'pipe' });
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CR-1: prunes a checkpoint whose task already has a commit', () => {
  const root = makeRepo();
  startTask({ id: 'M013-S005-T0002', phase: 6, plan: '06-01', wave: 1 }, root);
  commitFor(root, 'M013-S005-T0002');

  const { pruned, remaining } = reconcileCommittedCheckpoints(root);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].task_id, 'M013-S005-T0002');
  assert.match(pruned[0].sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(remaining, []);
  assert.deepEqual(listCheckpoints(root), []);
});

test('CR-2: keeps a checkpoint with no matching commit (genuine orphan)', () => {
  const root = makeRepo();
  startTask({ id: 'M013-S005-T0003', phase: 6, plan: '06-01', wave: 1 }, root);

  const { pruned, remaining } = reconcileCommittedCheckpoints(root);
  assert.deepEqual(pruned, []);
  assert.deepEqual(remaining, ['M013-S005-T0003']);
  assert.equal(listCheckpoints(root).length, 1);
});

test('CR-3: excludes the active current_task even when committed', () => {
  const root = makeRepo();
  startTask({ id: 'M013-S005-T0004', phase: 6, plan: '06-01', wave: 1 }, root);
  commitFor(root, 'M013-S005-T0004');

  const { pruned, remaining } = reconcileCommittedCheckpoints(root, { exclude: 'M013-S005-T0004' });
  assert.deepEqual(pruned, []);
  assert.deepEqual(remaining, ['M013-S005-T0004']);
  assert.equal(listCheckpoints(root).length, 1);
});

test('CR-4: prunes committed tombstone but keeps uncommitted sibling', () => {
  const root = makeRepo();
  startTask({ id: 'M013-S005-T0002', phase: 6, plan: '06-01', wave: 1 }, root);
  startTask({ id: 'M013-S005-T0003', phase: 6, plan: '06-01', wave: 1 }, root);
  commitFor(root, 'M013-S005-T0002');

  const { pruned, remaining } = reconcileCommittedCheckpoints(root);
  assert.deepEqual(pruned.map((p) => p.task_id), ['M013-S005-T0002']);
  assert.deepEqual(remaining, ['M013-S005-T0003']);
});

test('CR-5: committedSha returns null outside a git repo (no throw)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cr-nogit-'));
  _repos.push(root);
  assert.equal(committedSha('M013-S005-T0002', root), null);
});

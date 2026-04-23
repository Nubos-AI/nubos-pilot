'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const worktree = require('./worktree.cjs');

const _repos = [];

after(() => {
  for (const r of _repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

function makeRepo(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-worktree-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos-pilot.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (o.gitignored !== false) {
    fs.writeFileSync(path.join(root, '.gitignore'), '.nubos-pilot/worktrees/\n', 'utf-8');
    execFileSync('git', ['-C', root, 'add', '.gitignore'], { stdio: 'pipe' });
  }
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
  _repos.push(root);
  return root;
}

function writeConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify(cfg, null, 2),
    'utf-8',
  );
}

function commitFile(root, rel, body, message) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
  execFileSync('git', ['-C', root, 'add', rel], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', message], { stdio: 'pipe' });
}

test('WT-1: sliceBranchName builds np/<mid>-<sid> for a valid slice id', () => {
  assert.equal(worktree.sliceBranchName('M001-S001'), 'np/M001-S001');
  assert.equal(worktree.sliceBranchName('M042-S099'), 'np/M042-S099');
});

test('WT-2: sliceBranchName rejects malformed ids', () => {
  assert.throws(
    () => worktree.sliceBranchName('not-a-slice-id'),
    (err) => err.name === 'NubosPilotError' && err.code === 'layout-invalid-id',
  );
});

test('WT-3: parseSliceBranchName round-trips sliceBranchName', () => {
  const parsed = worktree.parseSliceBranchName('np/M003-S007');
  assert.deepEqual(parsed, { sliceFullId: 'M003-S007', milestone: 3, slice: 7 });
});

test('WT-4: parseSliceBranchName returns null for non-np branches', () => {
  assert.equal(worktree.parseSliceBranchName('main'), null);
  assert.equal(worktree.parseSliceBranchName('feature/foo'), null);
  assert.equal(worktree.parseSliceBranchName('np/not-valid'), null);
});

test('WT-5: sliceWorktreePath lives under .nubos-pilot/worktrees/<mid>/<sid>', () => {
  const root = makeRepo();
  const p = worktree.sliceWorktreePath('M001-S002', root);
  assert.equal(p, path.join(root, '.nubos-pilot', 'worktrees', 'M001', 'S002'));
});

test('WT-6: worktreeIsolationEnabled reads workflow.worktree_isolation flag', () => {
  const root = makeRepo();
  assert.equal(worktree.worktreeIsolationEnabled(root), false);
  writeConfig(root, { workflow: { worktree_isolation: true } });
  assert.equal(worktree.worktreeIsolationEnabled(root), true);
  writeConfig(root, { workflow: { worktree_isolation: false } });
  assert.equal(worktree.worktreeIsolationEnabled(root), false);
});

test('WT-7: createSliceWorktree creates a worktree and branch on current HEAD', () => {
  const root = makeRepo();
  const res = worktree.createSliceWorktree('M001-S001', root);

  assert.equal(res.slice_full_id, 'M001-S001');
  assert.equal(res.branch, 'np/M001-S001');
  assert.equal(res.path, path.join(root, '.nubos-pilot', 'worktrees', 'M001', 'S001'));
  assert.match(res.base_sha, /^[a-f0-9]{40}$/);

  assert.ok(fs.existsSync(res.path), 'worktree path must exist');
  const branchCheck = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/np/M001-S001']);
  assert.ok(branchCheck.toString().trim().length === 40);
});

test('WT-8: createSliceWorktree refuses to recreate an existing worktree', () => {
  const root = makeRepo();
  worktree.createSliceWorktree('M001-S001', root);
  assert.throws(
    () => worktree.createSliceWorktree('M001-S001', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-already-exists',
  );
});

test('WT-9: createSliceWorktree refuses to reuse an existing branch', () => {
  const root = makeRepo();
  execFileSync('git', ['-C', root, 'branch', 'np/M002-S001'], { stdio: 'pipe' });
  assert.throws(
    () => worktree.createSliceWorktree('M002-S001', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-branch-conflict',
  );
});

test('WT-10: listSliceWorktrees returns only np/ worktrees, not main', () => {
  const root = makeRepo();
  worktree.createSliceWorktree('M001-S001', root);
  worktree.createSliceWorktree('M001-S002', root);
  const list = worktree.listSliceWorktrees(root);
  assert.equal(list.length, 2);
  const ids = list.map((w) => w.slice_full_id).sort();
  assert.deepEqual(ids, ['M001-S001', 'M001-S002']);
  assert.ok(list[0].branch.startsWith('np/'));
});

test('WT-11: hasSliceWorktree reports correctly before and after creation', () => {
  const root = makeRepo();
  assert.equal(worktree.hasSliceWorktree('M001-S001', root), false);
  worktree.createSliceWorktree('M001-S001', root);
  assert.equal(worktree.hasSliceWorktree('M001-S001', root), true);
  assert.equal(worktree.hasSliceWorktree('M001-S002', root), false);
});

test('WT-12: removeSliceWorktree deletes the worktree and its branch', () => {
  const root = makeRepo();
  const res = worktree.createSliceWorktree('M001-S001', root);
  worktree.removeSliceWorktree('M001-S001', root);
  assert.equal(fs.existsSync(res.path), false);
  const branchCheck = execFileSync('git', ['-C', root, 'branch', '--list', 'np/M001-S001']).toString().trim();
  assert.equal(branchCheck, '');
});

test('WT-13: removeSliceWorktree with deleteBranch=false keeps the branch', () => {
  const root = makeRepo();
  worktree.createSliceWorktree('M001-S001', root);
  worktree.removeSliceWorktree('M001-S001', root, { deleteBranch: false });
  const branchCheck = execFileSync('git', ['-C', root, 'branch', '--list', 'np/M001-S001']).toString().trim();
  assert.match(branchCheck, /np\/M001-S001/);
});

test('WT-14: ffMergeSliceWorktree ff-merges a slice branch back to main', () => {
  const root = makeRepo();
  const created = worktree.createSliceWorktree('M001-S001', root);
  commitFile(created.path, 'src/foo.txt', 'hello', 'task: add foo');
  const res = worktree.ffMergeSliceWorktree('M001-S001', 'main', root);
  assert.match(res.merged_sha, /^[a-f0-9]{40}$/);

  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  assert.equal(head, res.merged_sha);
  assert.ok(fs.existsSync(path.join(root, 'src/foo.txt')));
});

test('WT-15: ffMergeSliceWorktree rejects a non-ff merge (main moved ahead)', () => {
  const root = makeRepo();
  worktree.createSliceWorktree('M001-S001', root);
  commitFile(path.join(root, '.nubos-pilot', 'worktrees', 'M001', 'S001'), 'in-slice.txt', 'x', 'task: slice work');
  commitFile(root, 'on-main.txt', 'y', 'chore: advance main');

  assert.throws(
    () => worktree.ffMergeSliceWorktree('M001-S001', 'main', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-ff-not-possible',
  );
});

test('WT-16: ffMergeSliceWorktree rejects when HEAD is on wrong branch', () => {
  const root = makeRepo();
  worktree.createSliceWorktree('M001-S001', root);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'other'], { stdio: 'pipe' });
  assert.throws(
    () => worktree.ffMergeSliceWorktree('M001-S001', 'main', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-ff-wrong-branch',
  );
});

test('WT-17: ffMergeSliceWorktree fails if the slice branch does not exist', () => {
  const root = makeRepo();
  assert.throws(
    () => worktree.ffMergeSliceWorktree('M001-S099', 'main', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-branch-missing',
  );
});

test('WT-18: _assertGitRepo fails outside a git repo', () => {
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'np-nonrepo-'));
  _repos.push(nonRepo);
  assert.throws(
    () => worktree.listSliceWorktrees(nonRepo),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-not-git-repo',
  );
});

test('WT-19: createSliceWorktree nests parent dirs under .nubos-pilot/worktrees/', () => {
  const root = makeRepo();
  const res = worktree.createSliceWorktree('M042-S013', root);
  assert.ok(res.path.endsWith(path.join('.nubos-pilot', 'worktrees', 'M042', 'S013')));
  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'worktrees', 'M042')));
});

test('WT-20: pruneSliceWorktrees does not throw on a clean repo', () => {
  const root = makeRepo();
  assert.doesNotThrow(() => worktree.pruneSliceWorktrees(root));
});

test('WT-21: createSliceWorktree refuses when .nubos-pilot/worktrees/ is NOT gitignored', () => {
  const root = makeRepo({ gitignored: false });
  assert.throws(
    () => worktree.createSliceWorktree('M001-S001', root),
    (err) => err.name === 'NubosPilotError' && err.code === 'worktree-not-gitignored',
  );
});

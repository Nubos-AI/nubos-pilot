'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, projectStateDir } = require('./core.cjs');
const { parseSliceFullId, mId, sId, sliceFullId: buildSliceFullId } = require('./layout.cjs');
const { runGit: _spawnGit } = require('./git.cjs');

const BRANCH_PREFIX = 'np/';
const WORKTREES_DIRNAME = 'worktrees';
const CONFIG_FLAG = 'worktree_isolation';

function _assertGitRepo(cwd) {
  const r = _spawnGit(['rev-parse', '--git-dir'], { cwd });
  if (!r.ok) {
    throw new NubosPilotError(
      'worktree-not-git-repo',
      'not inside a git repository: ' + cwd,
      { cwd, stderr: r.stderr },
    );
  }
}

function sliceBranchName(sliceFullIdStr) {
  parseSliceFullId(sliceFullIdStr);
  return BRANCH_PREFIX + sliceFullIdStr;
}

function parseSliceBranchName(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(BRANCH_PREFIX)) return null;
  const rest = branch.slice(BRANCH_PREFIX.length);
  try {
    const { milestone, slice } = parseSliceFullId(rest);
    return { sliceFullId: rest, milestone, slice };
  } catch { return null; }
}

function sliceWorktreePath(sliceFullIdStr, cwd) {
  const { milestone, slice } = parseSliceFullId(sliceFullIdStr);
  const base = projectStateDir(cwd || process.cwd());
  return path.join(base, WORKTREES_DIRNAME, mId(milestone), sId(slice));
}

function worktreeIsolationEnabled(cwd) {
  const cfgPath = path.join(projectStateDir(cwd || process.cwd()), 'config.json');
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const wf = cfg && cfg.workflow;
    if (!wf || typeof wf !== 'object') return false;
    return Boolean(wf[CONFIG_FLAG]);
  } catch { return false; }
}

function _currentHeadSha(cwd) {
  const r = _spawnGit(['rev-parse', 'HEAD'], { cwd });
  if (!r.ok) {
    throw new NubosPilotError(
      'worktree-rev-parse-failed',
      'git rev-parse HEAD failed: ' + (r.stderr || '').trim(),
      { cwd, stderr: r.stderr },
    );
  }
  return r.stdout.trim();
}

function _currentBranchName(cwd) {
  const r = _spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name === 'HEAD' ? null : name;
}

function _listRawWorktrees(cwd) {
  const r = _spawnGit(['worktree', 'list', '--porcelain'], { cwd });
  if (!r.ok) {
    throw new NubosPilotError(
      'worktree-list-failed',
      'git worktree list failed: ' + (r.stderr || '').trim(),
      { cwd, stderr: r.stderr },
    );
  }
  const entries = [];
  let current = null;
  const lines = r.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') {
      if (current) { entries.push(current); current = null; }
      continue;
    }
    if (!current) current = {};
    if (line.startsWith('worktree ')) current.worktree = line.slice(9);
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7);
    else if (line === 'bare') current.bare = true;
    else if (line === 'detached') current.detached = true;
  }
  if (current) entries.push(current);
  return entries;
}

function listSliceWorktrees(cwd) {
  _assertGitRepo(cwd);
  const raw = _listRawWorktrees(cwd);
  const out = [];
  for (const w of raw) {
    if (!w.branch) continue;
    const short = w.branch.startsWith('refs/heads/') ? w.branch.slice(11) : w.branch;
    const parsed = parseSliceBranchName(short);
    if (!parsed) continue;
    out.push({
      slice_full_id: parsed.sliceFullId,
      milestone: parsed.milestone,
      slice: parsed.slice,
      branch: short,
      path: w.worktree,
      head: w.head || null,
    });
  }
  out.sort((a, b) => a.slice_full_id.localeCompare(b.slice_full_id));
  return out;
}

function hasSliceWorktree(sliceFullIdStr, cwd) {
  const target = sliceWorktreePath(sliceFullIdStr, cwd);
  for (const w of listSliceWorktrees(cwd)) {
    if (path.resolve(w.path) === path.resolve(target)) return true;
    if (w.slice_full_id === sliceFullIdStr) return true;
  }
  return false;
}

function _assertWorktreesGitignored(cwd) {
  const stateDir = projectStateDir(cwd || process.cwd());
  const worktreesDir = path.join(stateDir, WORKTREES_DIRNAME);
  const rel = path.relative(cwd || process.cwd(), worktreesDir) + path.sep + '.placeholder';
  const r = _spawnGit(['check-ignore', '--quiet', '--', rel], { cwd });
  if (r.ok) return true;
  if (r.status === 1) {
    throw new NubosPilotError(
      'worktree-not-gitignored',
      'safety: ' + rel + ' must be gitignored before worktrees can be created. Add `.nubos-pilot/worktrees/` to your .gitignore.',
      { path: rel },
    );
  }
  throw new NubosPilotError(
    'worktree-gitignore-check-failed',
    'git check-ignore failed: ' + (r.stderr || '').trim(),
    { stderr: r.stderr },
  );
}

function createSliceWorktree(sliceFullIdStr, cwd) {
  _assertGitRepo(cwd);
  parseSliceFullId(sliceFullIdStr);
  _assertWorktreesGitignored(cwd);

  const branch = sliceBranchName(sliceFullIdStr);
  const targetPath = sliceWorktreePath(sliceFullIdStr, cwd);

  if (fs.existsSync(targetPath)) {
    throw new NubosPilotError(
      'worktree-already-exists',
      'worktree path already exists: ' + targetPath,
      { slice_full_id: sliceFullIdStr, path: targetPath },
    );
  }

  const branchCheck = _spawnGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { cwd });
  if (branchCheck.ok) {
    throw new NubosPilotError(
      'worktree-branch-conflict',
      'branch already exists: ' + branch,
      { slice_full_id: sliceFullIdStr, branch },
    );
  }

  const baseSha = _currentHeadSha(cwd);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const add = _spawnGit(
    ['worktree', 'add', '-b', branch, targetPath, baseSha],
    { cwd },
  );
  if (!add.ok) {
    throw new NubosPilotError(
      'worktree-add-failed',
      'git worktree add failed: ' + (add.stderr || '').trim(),
      { slice_full_id: sliceFullIdStr, branch, path: targetPath, stderr: add.stderr },
    );
  }

  return { slice_full_id: sliceFullIdStr, branch, path: targetPath, base_sha: baseSha };
}

function removeSliceWorktree(sliceFullIdStr, cwd, opts) {
  _assertGitRepo(cwd);
  const o = opts || {};
  const force = Boolean(o.force);
  const deleteBranch = o.deleteBranch !== false;

  const targetPath = sliceWorktreePath(sliceFullIdStr, cwd);
  const branch = sliceBranchName(sliceFullIdStr);

  const removeArgs = ['worktree', 'remove'];
  if (force) removeArgs.push('--force');
  removeArgs.push(targetPath);

  const r = _spawnGit(removeArgs, { cwd });
  if (!r.ok) {
    if (fs.existsSync(targetPath)) {
      throw new NubosPilotError(
        'worktree-remove-failed',
        'git worktree remove failed: ' + (r.stderr || '').trim(),
        { slice_full_id: sliceFullIdStr, path: targetPath, stderr: r.stderr, force },
      );
    }
  }

  if (deleteBranch) {
    const exists = _spawnGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { cwd });
    if (exists.ok) {
      const del = _spawnGit(['branch', '-D', branch], { cwd });
      if (!del.ok) {
        throw new NubosPilotError(
          'worktree-branch-delete-failed',
          'git branch -D ' + branch + ' failed: ' + (del.stderr || '').trim(),
          { slice_full_id: sliceFullIdStr, branch, stderr: del.stderr },
        );
      }
    }
  }

  _spawnGit(['worktree', 'prune'], { cwd });

  return { slice_full_id: sliceFullIdStr, removed: true, path: targetPath, branch };
}

function ffMergeSliceWorktree(sliceFullIdStr, targetBranch, cwd) {
  _assertGitRepo(cwd);
  parseSliceFullId(sliceFullIdStr);

  const branch = sliceBranchName(sliceFullIdStr);

  const existCheck = _spawnGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { cwd });
  if (!existCheck.ok) {
    throw new NubosPilotError(
      'worktree-branch-missing',
      'slice branch not found: ' + branch,
      { slice_full_id: sliceFullIdStr, branch },
    );
  }

  const currentBranch = _currentBranchName(cwd);
  if (targetBranch && currentBranch && currentBranch !== targetBranch) {
    throw new NubosPilotError(
      'worktree-ff-wrong-branch',
      'ff-merge requires HEAD on ' + targetBranch + ' but is on ' + currentBranch,
      { slice_full_id: sliceFullIdStr, expected: targetBranch, actual: currentBranch },
    );
  }

  const merge = _spawnGit(['merge', '--ff-only', branch], { cwd });
  if (!merge.ok) {
    throw new NubosPilotError(
      'worktree-ff-not-possible',
      'git merge --ff-only failed for ' + branch + ': ' + (merge.stderr || '').trim(),
      { slice_full_id: sliceFullIdStr, branch, target_branch: targetBranch || currentBranch, stderr: merge.stderr },
    );
  }

  const mergedSha = _currentHeadSha(cwd);
  return { slice_full_id: sliceFullIdStr, branch, target_branch: targetBranch || currentBranch, merged_sha: mergedSha };
}

function pruneSliceWorktrees(cwd) {
  _assertGitRepo(cwd);
  const r = _spawnGit(['worktree', 'prune'], { cwd });
  if (!r.ok) {
    throw new NubosPilotError(
      'worktree-prune-failed',
      'git worktree prune failed: ' + (r.stderr || '').trim(),
      { cwd, stderr: r.stderr },
    );
  }
  return { pruned: true };
}

module.exports = {
  BRANCH_PREFIX,
  WORKTREES_DIRNAME,
  CONFIG_FLAG,
  sliceBranchName,
  parseSliceBranchName,
  sliceWorktreePath,
  worktreeIsolationEnabled,
  listSliceWorktrees,
  hasSliceWorktree,
  createSliceWorktree,
  removeSliceWorktree,
  ffMergeSliceWorktree,
  pruneSliceWorktrees,
};

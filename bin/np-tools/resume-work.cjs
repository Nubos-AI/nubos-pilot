const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const { readState } = require('../../lib/state.cjs');
const { readCheckpoint, listCheckpoints } = require('../../lib/checkpoint.cjs');
const { TASK_ID_RE } = require('../../lib/tasks.cjs');
const textMode = require('../../lib/text-mode.cjs');
const layout = require('../../lib/layout.cjs');
const { readSnapshot } = require('../../lib/session-snapshot.cjs');
const {
  hasSliceWorktree,
  sliceWorktreePath,
  sliceBranchName,
  worktreeIsolationEnabled,
  listSliceWorktrees,
} = require('../../lib/worktree.cjs');

function _worktreeInfoForTask(taskId, cwd) {
  if (!taskId || !worktreeIsolationEnabled(cwd)) return null;
  let parsed;
  try { parsed = layout.parseTaskFullId(taskId); } catch { return null; }
  const sliceFullId = layout.sliceFullId(parsed.milestone, parsed.slice);
  let exists = false;
  try { exists = hasSliceWorktree(sliceFullId, cwd); } catch { exists = false; }
  if (!exists) return null;
  return {
    slice_full_id: sliceFullId,
    branch: sliceBranchName(sliceFullId),
    path: sliceWorktreePath(sliceFullId, cwd),
  };
}

function _safeReadState(cwd) {
  try { return readState(cwd); } catch { return null; }
}

function _validateCheckpointSchema(cp) {

  
  if (!cp || typeof cp !== 'object') return false;
  if (cp.schema_version !== 1) return false;
  if (typeof cp.task_id !== 'string' || !TASK_ID_RE.test(cp.task_id)) return false;
  return true;
}

function run(_args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;

  const state = _safeReadState(cwd);
  const currentTask = state && state.frontmatter ? state.frontmatter.current_task : null;
  const cpFiles = listCheckpoints(cwd);

  let payload;
  if (currentTask && cpFiles.length > 0) {
    const cp = readCheckpoint(currentTask, cwd);
    if (cp && _validateCheckpointSchema(cp) && cp.status !== 'done') {
      payload = {
        _workflow: 'resume-work',
        status: 'resume',
        task_id: currentTask,
        checkpoint: cp,
      };
    } else if (cp && !_validateCheckpointSchema(cp)) {
      throw new NubosPilotError(
        'checkpoint-schema-mismatch',
        'Checkpoint file schema invalid for task ' + currentTask,
        { task: currentTask },
      );
    } else {

      const orphanIds = cpFiles.map((f) => path.basename(f, '.json'));
      payload = {
        _workflow: 'resume-work',
        status: 'orphan',
        checkpoint_ids: orphanIds,
        current_task: currentTask,
      };
    }
  } else if (cpFiles.length > 0) {
    const orphanIds = cpFiles.map((f) => path.basename(f, '.json'));
    payload = {
      _workflow: 'resume-work',
      status: 'orphan',
      checkpoint_ids: orphanIds,
      current_task: currentTask,
    };
  } else {
    payload = {
      _workflow: 'resume-work',
      status: 'clean',
      message: 'no active work',
    };
  }

  const tmDetail = textMode.resolveTextModeDetail(cwd);
  payload.text_mode = tmDetail.enabled;
  payload.text_mode_source = tmDetail.source;

  const wtInfo = _worktreeInfoForTask(currentTask, cwd);
  if (wtInfo) payload.worktree = wtInfo;
  payload.worktree_isolation = worktreeIsolationEnabled(cwd);
  let stale = [];
  try {
    stale = listSliceWorktrees(cwd).filter((w) => {
      const b = w.branch;
      const activeBranch = wtInfo && wtInfo.branch;
      return b !== activeBranch;
    });
  } catch { stale = []; }
  if (stale.length > 0) {
    payload.stale_worktrees = stale.map((w) => ({
      slice_full_id: w.slice_full_id,
      branch: w.branch,
      path: w.path,
    }));
  }

  const snap = readSnapshot(cwd);
  if (snap) {
    payload.session_snapshot = {
      captured_at: snap.captured_at,
      milestone: snap.milestone,
      current_task: snap.current_task,
      last_commits: (snap.last_commits || []).slice(0, 5),
      open_handoffs: snap.open_handoffs || [],
    };
  }

  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

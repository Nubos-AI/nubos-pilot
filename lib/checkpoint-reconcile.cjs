const path = require('node:path');
const { listCheckpoints, deleteCheckpoint } = require('./checkpoint.cjs');
const { findCommitByTaskId } = require('./git.cjs');
const { TASK_ID_RE } = require('./ids.cjs');

function committedSha(taskId, cwd) {
  try {
    return findCommitByTaskId(taskId, cwd);
  } catch {
    return null;
  }
}

function reconcileCommittedCheckpoints(cwd = process.cwd(), opts = {}) {
  const exclude = opts.exclude || null;
  const pruned = [];
  const remaining = [];
  for (const file of listCheckpoints(cwd)) {
    const taskId = path.basename(file, '.json');
    if (!TASK_ID_RE.test(taskId)) {
      remaining.push(taskId);
      continue;
    }
    if (exclude && taskId === exclude) {
      remaining.push(taskId);
      continue;
    }
    const sha = committedSha(taskId, cwd);
    if (sha) {
      deleteCheckpoint(taskId, cwd);
      pruned.push({ task_id: taskId, sha });
    } else {
      remaining.push(taskId);
    }
  }
  return { pruned, remaining };
}

module.exports = {
  committedSha,
  reconcileCommittedCheckpoints,
};

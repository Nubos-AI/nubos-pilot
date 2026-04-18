const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, withFileLocks, atomicWriteFileSync, projectStateDir } = require('./core.cjs');
const { parseState, serializeState } = require('./state.cjs');
const {
  findCommitByTaskId,
  revertCommit,
  restoreFiles,
  listTaskCommits,
} = require('./git.cjs');
const {
  readCheckpoint,
  deleteCheckpoint,
  checkpointPath,
} = require('./checkpoint.cjs');
const { setTaskStatus, TASK_ID_RE } = require('./tasks.cjs');
const { paddedPhase } = require('./phase.cjs');

function _statePath(cwd) {
  return path.join(projectStateDir(cwd), 'STATE.md');
}

function _findPlanDirForTask(taskId, cwd) {

  
  const phasesRoot = path.join(projectStateDir(cwd), 'phases');
  let entries;
  try {
    entries = fs.readdirSync(phasesRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const padded = taskId.slice(0, 2);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!(e.name === padded || e.name.startsWith(padded + '-'))) continue;
    const candidate = path.join(phasesRoot, e.name, 'tasks', taskId + '.md');
    if (fs.existsSync(candidate)) return path.join(phasesRoot, e.name);
  }
  return null;
}

function _extractTaskIdFromSubject(subject) {

  
  const m = String(subject).match(/^task\(([^)]+)\):/);
  if (!m) return null;
  if (!TASK_ID_RE.test(m[1])) return null;
  return m[1];
}

function undoTask(id, cwd = process.cwd()) {

  

  const sha = findCommitByTaskId(id);

  
  try {
    revertCommit(sha);
  } catch (err) {
    throw new NubosPilotError(
      'undo-revert-conflict',
      'git revert failed for task ' + id + ' (sha ' + sha + ')',
      { taskId: id, sha, cause: err && err.message },
    );
  }
  const planDir = _findPlanDirForTask(id, cwd);
  if (planDir) {
    try { setTaskStatus(id, 'pending', planDir); }
    catch (err) {

      
      process.stderr.write('[nubos-pilot warn] setTaskStatus pending failed for ' + id + ': ' + (err && err.message) + '\n');
    }
  }
  return { task_id: id, reverted_sha: sha };
}

function resetSlice(cwd = process.cwd()) {

  

  const statePath = _statePath(cwd);
  const stateBody = fs.readFileSync(statePath, 'utf-8');
  const state = parseState(stateBody);
  const currentTask = state.frontmatter && state.frontmatter.current_task;
  if (currentTask == null) {
    throw new NubosPilotError(
      'undo-dirty-tree',
      'No current_task in STATE.md — nothing to reset',
      {},
    );
  }
  const cp = readCheckpoint(currentTask, cwd);
  if (!cp) {
    throw new NubosPilotError(
      'checkpoint-orphan',
      'STATE.current_task=' + currentTask + ' but no checkpoint file',
      { current_task: currentTask },
    );
  }
  const files = Array.isArray(cp.files_touched) ? cp.files_touched : [];
  if (files.length > 0) restoreFiles(files);

  const cpPath = checkpointPath(currentTask, cwd);
  withFileLocks([statePath, cpPath], () => {

    const fresh = parseState(fs.readFileSync(statePath, 'utf-8'));
    fresh.frontmatter.current_task = null;
    atomicWriteFileSync(statePath, serializeState(fresh));
    try { fs.unlinkSync(cpPath); } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  });

  const planDir = _findPlanDirForTask(currentTask, cwd);
  if (planDir) {
    try { setTaskStatus(currentTask, 'pending', planDir); }
    catch (err) {
      process.stderr.write('[nubos-pilot warn] setTaskStatus pending failed for ' + currentTask + ': ' + (err && err.message) + '\n');
    }
  }
  return { task_id: currentTask, restored_paths: files };
}

function _undoCommitsBatch(prefix, cwd) {

  

  const commits = listTaskCommits(prefix);
  if (commits.length === 0) {
    return { reverted: [], pending_count: 0, message: 'nothing to revert' };
  }
  const reverted = [];
  const taskIds = new Set();
  for (const c of commits) {
    revertCommit(c.sha);
    reverted.push({ sha: c.sha, subject: c.subject });
    const tid = _extractTaskIdFromSubject(c.subject);
    if (tid) taskIds.add(tid);
  }

  for (const tid of taskIds) {
    const planDir = _findPlanDirForTask(tid, cwd);
    if (!planDir) continue;
    try { setTaskStatus(tid, 'pending', planDir); }
    catch (err) {
      process.stderr.write('[nubos-pilot warn] setTaskStatus pending failed for ' + tid + ': ' + (err && err.message) + '\n');
    }
  }
  return { reverted, pending_count: taskIds.size };
}

function undoPlan(planId, cwd = process.cwd()) {
  if (typeof planId !== 'string' || !/^\d{2}-\d{2}$/.test(planId)) {
    throw new NubosPilotError(
      'undo-invalid-plan-id',
      'undoPlan requires a plan id in NN-NN form, got: ' + planId,
      { planId },
    );
  }
  return _undoCommitsBatch(planId, cwd);
}

function undoPhase(n, cwd = process.cwd()) {

  const padded = paddedPhase(n);
  return _undoCommitsBatch(padded, cwd);
}

module.exports = {
  undoTask,
  undoPlan,
  undoPhase,
  resetSlice,
};

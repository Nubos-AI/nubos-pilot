const fs = require('node:fs');
const path = require('node:path');
const {
  withFileLocks,
  withFileLock,
  atomicWriteFileSync,
  projectStateDir,
  NubosPilotError,
} = require('./core.cjs');
const { parseState, serializeState } = require('./state.cjs');

const CHECKPOINT_SCHEMA_VERSION = 1;

function checkpointPath(taskId, cwd = process.cwd()) {
  return path.join(projectStateDir(cwd), 'checkpoints', `${taskId}.json`);
}

function _statePath(cwd) {
  return path.join(projectStateDir(cwd), 'STATE.md');
}

function _nowIso() {
  return new Date().toISOString();
}

function startTask(task, cwd = process.cwd()) {
  if (!task || typeof task.id !== 'string' || task.id.length === 0) {
    throw new NubosPilotError(
      'checkpoint-invalid-task',
      'startTask requires a task object with non-empty .id',
      { task },
    );
  }
  const cpPath = checkpointPath(task.id, cwd);
  const statePath = _statePath(cwd);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });

  

  return withFileLocks([statePath, cpPath], () => {
    const cp = {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      task_id: task.id,
      phase: task.phase == null ? null : task.phase,
      plan: task.plan == null ? null : task.plan,
      wave: task.wave == null ? null : task.wave,
      status: 'in-progress',
      started_at: _nowIso(),
      last_update: _nowIso(),
      files_touched: [],
      resume_hint: null,
    };
    atomicWriteFileSync(cpPath, JSON.stringify(cp, null, 2));

    

    const current = parseState(fs.readFileSync(statePath, 'utf-8'));
    current.frontmatter.current_task = task.id;
    if (task.plan != null) current.frontmatter.current_plan = task.plan;
    if (task.phase != null) current.frontmatter.current_phase = task.phase;
    atomicWriteFileSync(statePath, serializeState(current));
    return cp;
  });
}

function readCheckpoint(taskId, cwd = process.cwd()) {
  const p = checkpointPath(taskId, cwd);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeCheckpoint(taskId, partial, cwd = process.cwd()) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new NubosPilotError(
      'checkpoint-invalid-task-id',
      'writeCheckpoint requires a non-empty taskId',
      { taskId },
    );
  }
  const cpPath = checkpointPath(taskId, cwd);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  return withFileLock(cpPath, () => {
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const merged = {
      ...existing,
      ...(partial || {}),
      schema_version: CHECKPOINT_SCHEMA_VERSION, 
      last_update: _nowIso(),
    };
    atomicWriteFileSync(cpPath, JSON.stringify(merged, null, 2));
    return merged;
  });
}

function deleteCheckpoint(taskId, cwd = process.cwd()) {
  const p = checkpointPath(taskId, cwd);
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

function listCheckpoints(cwd = process.cwd()) {
  const dir = path.join(projectStateDir(cwd), 'checkpoints');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointPath,
  startTask,
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
};

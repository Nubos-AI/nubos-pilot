const fs = require('node:fs');
const path = require('node:path');
const {
  withFileLocks,
  withFileLock,
  atomicWriteFileSync,
  projectStateDir,
  NubosPilotError,
  safeAssign,
} = require('./core.cjs');
const { parseState, serializeState } = require('./state.cjs');
const { TASK_ID_RE } = require('./ids.cjs');
const { assertValid } = require('./validate.cjs');

const CHECKPOINT_SCHEMA_VERSION = 1;
const STORE_SCHEMA = 'checkpoint.v1';

function _assertSafeTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'checkpoint-invalid-task-id',
      'taskId must match M<NNN>-S<NNN>-T<NNNN> (got ' + JSON.stringify(taskId) + ')',
      { taskId, expected: TASK_ID_RE.toString() },
    );
  }
}

function checkpointPath(taskId, cwd = process.cwd()) {
  _assertSafeTaskId(taskId);
  const dir = path.resolve(projectStateDir(cwd), 'checkpoints');
  const candidate = path.resolve(dir, taskId + '.json');
  if (path.dirname(candidate) !== dir) {
    throw new NubosPilotError(
      'checkpoint-path-traversal',
      'computed checkpoint path escapes the checkpoints directory',
      { taskId, dir, candidate },
    );
  }
  return candidate;
}

function _statePath(cwd) {
  return path.join(projectStateDir(cwd), 'STATE.md');
}

function _nowIso() {
  return new Date().toISOString();
}

function _assertCompatibleSchema(existing, cpPath) {
  if (!existing || typeof existing !== 'object') return;
  if (Object.keys(existing).length === 0) return;
  if (!('schema_version' in existing)) {
    throw new NubosPilotError(
      'checkpoint-schema-version-missing',
      'checkpoint exists but has no schema_version field',
      {
        path: cpPath,
        hint: 'Either upgrade-stamp the file by adding schema_version=' + CHECKPOINT_SCHEMA_VERSION + ' manually, or delete it.',
      },
    );
  }
  const v = Number(existing.schema_version);
  if (!Number.isFinite(v)) {
    throw new NubosPilotError(
      'checkpoint-schema-version-corrupt',
      'checkpoint has non-numeric schema_version',
      { path: cpPath, got: existing.schema_version },
    );
  }
  if (v > CHECKPOINT_SCHEMA_VERSION) {
    throw new NubosPilotError(
      'checkpoint-version-mismatch',
      'checkpoint was written by a newer nubos-pilot release (schema_version=' + v + ', this binary supports ' + CHECKPOINT_SCHEMA_VERSION + ')',
      {
        path: cpPath,
        expected: CHECKPOINT_SCHEMA_VERSION,
        got: v,
        hint: 'Upgrade nubos-pilot to a release that supports this checkpoint, or back up + remove the checkpoint to start fresh.',
      },
    );
  }
  assertValid(existing, STORE_SCHEMA, 'checkpoint-corrupt', { path: cpPath });
}

function _sliceFromTaskId(taskId) {
  if (typeof taskId !== 'string') return null;
  const m = taskId.match(/^(M\d{3}-S\d{3})-T\d{4}$/);
  return m ? m[1] : null;
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
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(cpPath, 'utf-8')); }
    catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    _assertCompatibleSchema(prior, cpPath);
    const cp = {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      task_id: task.id,
      phase: task.phase == null ? null : task.phase,
      plan: task.plan == null ? null : task.plan,
      wave: task.wave == null ? null : task.wave,
      status: 'in-progress',
      started_at: prior && prior.started_at ? prior.started_at : _nowIso(),
      last_update: _nowIso(),
      files_touched: prior && Array.isArray(prior.files_touched) ? prior.files_touched : [],
      resume_hint: prior && prior.resume_hint != null ? prior.resume_hint : null,
    };
    if (prior && prior.nubosloop && typeof prior.nubosloop === 'object') {
      cp.nubosloop = prior.nubosloop;
      cp.nubosloop.restart_count = (Number(cp.nubosloop.restart_count) || 0) + 1;
      cp.nubosloop.restarted_at = _nowIso();
    }
    atomicWriteFileSync(cpPath, JSON.stringify(cp, null, 2));

    const current = parseState(fs.readFileSync(statePath, 'utf-8'));
    current.frontmatter.current_task = task.id;
    if (task.plan != null) current.frontmatter.current_plan = task.plan;
    if (task.phase != null) current.frontmatter.current_phase = task.phase;
    const sliceFromArg = task.slice;
    const sliceFromId = _sliceFromTaskId(task.id);
    const resolvedSlice = sliceFromArg != null ? sliceFromArg : sliceFromId;
    if (resolvedSlice != null) current.frontmatter.current_slice = resolvedSlice;
    current.frontmatter.last_updated = new Date().toISOString();
    atomicWriteFileSync(statePath, serializeState(current));
    return cp;
  });
}

function readCheckpoint(taskId, cwd = process.cwd()) {
  const p = checkpointPath(taskId, cwd);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  _assertCompatibleSchema(parsed, p);
  return parsed;
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
    _assertCompatibleSchema(existing, cpPath);
    const merged = safeAssign({}, existing, partial || {}, {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      last_update: _nowIso(),
    });
    atomicWriteFileSync(cpPath, JSON.stringify(merged, null, 2));
    return merged;
  });
}

function mergeCheckpoint(taskId, mergeFn, cwd = process.cwd()) {
  if (typeof mergeFn !== 'function') {
    throw new NubosPilotError(
      'checkpoint-invalid-merge-fn',
      'mergeCheckpoint requires a (current) => partial merge function',
      { taskId },
    );
  }
  const cpPath = checkpointPath(taskId, cwd);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  return withFileLock(cpPath, () => {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(cpPath, 'utf-8')); }
    catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    _assertCompatibleSchema(existing, cpPath);
    const partial = mergeFn(existing) || {};
    const merged = safeAssign({}, existing, partial, {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      last_update: _nowIso(),
    });
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

function finishTask(taskId, cwd = process.cwd()) {
  _assertSafeTaskId(taskId);
  const cpPath = checkpointPath(taskId, cwd);
  const statePath = _statePath(cwd);
  return withFileLocks([statePath, cpPath], () => {
    let stateRaw;
    let stateExists = true;
    try { stateRaw = fs.readFileSync(statePath, 'utf-8'); }
    catch (err) {
      if (err && err.code === 'ENOENT') stateExists = false;
      else throw err;
    }
    let cleared = false;
    if (stateExists) {
      const current = parseState(stateRaw);
      cleared = current.frontmatter.current_task === taskId;
      if (cleared) {
        current.frontmatter.current_task = null;
        current.frontmatter.current_phase = null;
        current.frontmatter.current_plan = null;
        current.frontmatter.last_updated = new Date().toISOString();
        atomicWriteFileSync(statePath, serializeState(current));
      }
    }
    try { fs.unlinkSync(cpPath); }
    catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    return { task_id: taskId, state_cleared: cleared, state_present: stateExists };
  });
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
  mergeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  finishTask,
  listCheckpoints,
};

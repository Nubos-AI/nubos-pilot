const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const { readState } = require('../../lib/state.cjs');
const { readCheckpoint, listCheckpoints } = require('../../lib/checkpoint.cjs');
const { TASK_ID_RE } = require('../../lib/tasks.cjs');

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

  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

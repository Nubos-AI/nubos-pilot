const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE } = require('../../lib/tasks.cjs');
const {
  startTask,
  writeCheckpoint,
  readCheckpoint,
} = require('../../lib/checkpoint.cjs');

const _VALID_STATUSES = new Set(['in-progress', 'verifying', 'pre-commit', 'done']);

function _parseFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--phase' || a === '--plan' || a === '--wave') {
      flags[a.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return flags;
}

function _assertTaskId(id) {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    throw new NubosPilotError(
      'checkpoint-invalid-task-id',
      'Invalid task-id format: ' + id + ' (expected <NN-NN-TNN>)',
      { id },
    );
  }
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];
  const taskId = list[1];

  switch (verb) {
    case 'start': {
      _assertTaskId(taskId);
      const flags = _parseFlags(list.slice(2));
      const task = {
        id: taskId,
        phase: flags.phase != null ? Number(flags.phase) : null,
        plan: flags.plan != null ? String(flags.plan) : null,
        wave: flags.wave != null ? Number(flags.wave) : null,
      };
      const cp = startTask(task, cwd);
      stdout.write(JSON.stringify(cp));
      return cp;
    }
    case 'transition': {
      _assertTaskId(taskId);
      const status = list[2];
      if (!_VALID_STATUSES.has(status)) {
        throw new NubosPilotError(
          'checkpoint-invalid-status',
          'Invalid checkpoint status: ' + status + ' (allowed: ' + [..._VALID_STATUSES].join(', ') + ')',
          { status, allowed: [..._VALID_STATUSES] },
        );
      }
      const cp = writeCheckpoint(taskId, { status }, cwd);
      stdout.write(JSON.stringify(cp));
      return cp;
    }
    case 'touch': {
      _assertTaskId(taskId);
      const file = list[2];
      if (!file) {
        throw new NubosPilotError(
          'checkpoint-missing-file',
          'checkpoint touch requires <file>',
          { taskId },
        );
      }
      const existing = readCheckpoint(taskId, cwd) || { files_touched: [] };
      const touched = Array.isArray(existing.files_touched) ? existing.files_touched.slice() : [];
      if (!touched.includes(file)) touched.push(file);
      const cp = writeCheckpoint(taskId, { files_touched: touched }, cwd);
      stdout.write(JSON.stringify(cp));
      return cp;
    }
    case 'show': {
      _assertTaskId(taskId);
      const cp = readCheckpoint(taskId, cwd);
      stdout.write(JSON.stringify(cp));
      return cp;
    }
    default:
      throw new NubosPilotError(
        'checkpoint-unknown-verb',
        'checkpoint: unknown verb: ' + String(verb) + ' (allowed: start, transition, touch, show)',
        { verb },
      );
  }
}

module.exports = { run };

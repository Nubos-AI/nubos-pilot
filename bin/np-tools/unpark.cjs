const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');
const { TASK_ID_RE, setTaskStatus } = require('../../lib/tasks.cjs');

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

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list[0];
  if (!taskId) {
    throw new NubosPilotError('unpark-missing-task-id', 'unpark requires a task id', {});
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError('unpark-invalid-task-id', 'Invalid task id: ' + taskId, { taskId });
  }
  const planDir = _findPlanDirForTask(taskId, cwd);
  if (!planDir) {
    throw new NubosPilotError('task-not-found', 'No task file found for id ' + taskId, { taskId });
  }
  setTaskStatus(taskId, 'pending', planDir);
  const payload = { ok: true, task_id: taskId, status: 'pending' };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

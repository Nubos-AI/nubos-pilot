'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const layout = require('../../lib/layout.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { verifyCommandLines } = require('../../lib/verify-block.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list.find((a) => a && !a.startsWith('--')) || null;

  if (!taskId || !TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'task-verify-cmd-invalid-task-id',
      'Invalid task id: ' + taskId + ' (expected M<NNN>-S<NNN>-T<NNNN>)',
      { taskId },
    );
  }

  const parsed = layout.parseTaskFullId(taskId);
  const planPath = layout.taskPlanPath(parsed.milestone, parsed.slice, parsed.task, cwd);
  if (!fs.existsSync(planPath)) {
    throw new NubosPilotError(
      'task-verify-cmd-plan-not-found',
      'No task plan found for ' + taskId,
      { taskId },
    );
  }

  const { body } = extractFrontmatter(fs.readFileSync(planPath, 'utf-8'));
  const lines = verifyCommandLines(body);
  if (!lines.length) {
    // Fail closed: an empty verify block means the task has no mechanical check.
    // Returning "" here would let the orchestrator run `bash -c ""`, exit 0, and
    // read that as a passing verify — the failure mode this verb exists to end.
    throw new NubosPilotError(
      'task-verify-cmd-no-verify-block',
      'Task ' + taskId + ' has no executable <verify> command',
      { taskId, hint: 'every task plan must carry a runnable <verify> block (ADR-0019)' },
    );
  }

  if (list.includes('--json')) {
    stdout.write(JSON.stringify({ task_id: taskId, lines }) + '\n');
  } else {
    stdout.write(lines.join('\n') + '\n');
  }
  return 0;
}

module.exports = { run };

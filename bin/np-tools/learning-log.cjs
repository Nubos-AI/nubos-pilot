'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE, MILESTONE_ID_RE } = require('../../lib/ids.cjs');
const knowledgeAdapter = require('../../lib/knowledge-adapter.cjs');
const { getFlag } = require('./_args.cjs');

function _assertOptionalTaskId(id) {
  if (id == null) return;
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    throw new NubosPilotError(
      'learning-log-invalid-task-id',
      'optional --task-id must match M<NNN>-S<NNN>-T<NNNN>',
      { taskId: id },
    );
  }
}

function _assertOptionalMilestoneId(id) {
  if (id == null) return;
  if (typeof id !== 'string' || !MILESTONE_ID_RE.test(id)) {
    throw new NubosPilotError(
      'learning-log-invalid-milestone-id',
      'optional --milestone-id must match M<NNN>',
      { milestoneId: id },
    );
  }
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];

  const pattern = getFlag(list, '--pattern');
  const outcome = getFlag(list, '--outcome');
  const taskId = getFlag(list, '--task-id') || null;
  const milestoneId = getFlag(list, '--milestone-id') || null;

  if (!pattern || !outcome) {
    throw new NubosPilotError(
      'learning-log-missing-args',
      'learning-log requires --pattern and --outcome',
      { hint: 'example: learning-log --pattern "use jose for jwt" --outcome verified --task-id M001-S001-T0001' },
    );
  }
  _assertOptionalTaskId(taskId);
  _assertOptionalMilestoneId(milestoneId);

  const learnings = require('../../lib/learnings.cjs');
  const fingerprint = learnings._fingerprint(pattern);
  const adapter = knowledgeAdapter.getAdapter(cwd);
  const result = adapter.log({ pattern, outcome, task_id: taskId, milestone_id: milestoneId });
  let occurrence = 1;
  if (Array.isArray(result && result.learnings)) {
    const entry = result.learnings.find((l) => l.fingerprint === fingerprint);
    if (entry) occurrence = entry.occurrence;
  }
  const payload = {
    adapter: adapter.name,
    persisted: true,
    fingerprint,
    was_new: occurrence === 1,
    occurrence,
    learnings_count: Array.isArray(result && result.learnings) ? result.learnings.length : null,
  };
  stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

module.exports = { run };

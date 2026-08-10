'use strict';

const { safeAssign } = require('../../lib/core.cjs');
const checkpoint = require('../../lib/checkpoint.cjs');
const args = require('./_args.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');

function _parseReason(rest) {
  const raw = args.getFlag(rest, '--reason');
  return raw == null ? '' : String(raw).slice(0, 300);
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const taskId = list[0];
  args.assertMatch(taskId, TASK_ID_RE, 'loop-stuck-invalid-task-id', 'taskId');
  const tail = list.slice(1);
  const reason = _parseReason(tail);
  const findings = args.optionalJsonFlag(tail, '--findings');
  const merged = checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prevLoop = (cur && cur.nubosloop) || {};
      const partialLoop = {
        last_action: 'stuck',
        stuck: true,
        stuck_reason: reason || null,
        stuck_at: new Date().toISOString(),
      };
      if (findings !== undefined) partialLoop.findings = findings;
      return {
        status: 'stuck',
        nubosloop: safeAssign({}, prevLoop, partialLoop),
      };
    },
    cwd,
  );
  const payload = {
    task_id: taskId,
    nubosloop: merged.nubosloop || null,
    status: 'stuck',
  };
  stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

module.exports = { run };

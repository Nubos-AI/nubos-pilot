'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const nubosloop = require('../../lib/nubosloop.cjs');
const args = require('./_args.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const taskId = list[0];
  args.assertMatch(taskId, TASK_ID_RE, 'loop-state-invalid-task-id', 'taskId');
  const partial = args.getJsonFlag(
    list.slice(1),
    '--json',
    'loop-state-missing-json',
    "example: loop-state-record M001-S001-T0001 --json '{\"last_action\":\"awaiting-user\"}'",
  );
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new NubosPilotError(
      'loop-state-invalid-json',
      'loop-state-record --json payload must be a JSON object',
      {},
    );
  }
  const ALLOWED_KEYS = new Set([
    'last_action',
    'user_reply',
    'pending_askuser_spec',
    'max_rounds_override',
  ]);
  for (const k of Object.keys(partial)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new NubosPilotError(
        'loop-state-unknown-key',
        'loop-state-record --json contains unknown key "' + k + '"',
        { key: k, allowed: Array.from(ALLOWED_KEYS).sort() },
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'max_rounds_override')) {
    const m = partial.max_rounds_override;
    if (m !== null && (!Number.isInteger(m) || m < 1)) {
      throw new NubosPilotError(
        'loop-state-invalid-value',
        'loop-state-record --json max_rounds_override must be a positive integer (>=1) or null to clear, got ' + JSON.stringify(m),
        { key: 'max_rounds_override', got: m },
      );
    }
  }
  const merged = nubosloop.recordLoopState(taskId, partial, cwd);
  stdout.write(JSON.stringify({ task_id: taskId, nubosloop: merged.nubosloop || null }) + '\n');
  return merged;
}

module.exports = { run };

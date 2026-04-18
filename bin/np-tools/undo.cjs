const { NubosPilotError } = require('../../lib/core.cjs');
const { undoPhase, undoPlan } = require('../../lib/undo.cjs');

const PLAN_RE = /^\d{2}-\d{2}$/;
const PHASE_RE = /^\d+(\.\d+)?$/;

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const arg = list[0];
  if (!arg) {
    throw new NubosPilotError(
      'undo-missing-arg',
      'undo requires a phase number or plan id',
      {},
    );
  }
  let result;
  if (PLAN_RE.test(arg)) {
    result = undoPlan(arg, cwd);
  } else if (PHASE_RE.test(arg)) {
    result = undoPhase(arg, cwd);
  } else {
    throw new NubosPilotError(
      'undo-invalid-arg',
      'undo arg must be a phase number (e.g. 6) or plan id (e.g. 06-01), got: ' + arg,
      { arg },
    );
  }
  const payload = {
    ok: true,
    target: arg,
    reverted: result.reverted,
    pending_count: result.pending_count,
  };
  if (result.message) payload.message = result.message;
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

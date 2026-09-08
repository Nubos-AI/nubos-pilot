'use strict';

// CLI surface for conditional slice edges (ADR-0028).
//
// The orchestrator asks this before dispatching a wave: which slices run, which
// are permanently out, and which are not decided yet. It never asks the executor
// to judge a condition — the condition is data in roadmap.yaml and the decision
// is deterministic, which is what keeps the plan reviewable.

const sc = require('../../lib/slice-conditions.cjs');
const { parseRoadmap, _findPhaseTarget } = require('../../lib/roadmap.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs slice-plan plan <N> [--json]',
    '  np-tools.cjs slice-plan lint [--json]',
    '',
    'Evaluates conditional slice edges for a milestone. A slice may carry a `when`',
    'that gates it on how an earlier slice in the same milestone turned out; a slice',
    'without one is unconditional, which stays the default.',
    '',
    'Decisions are three-valued, and the third one matters:',
    '  run   the condition holds — dispatch the slice',
    '  skip  the condition can no longer hold — the slice is permanently out',
    '  wait  not decided yet — the referenced slice has not reached a terminal state',
    '',
    'Collapsing `wait` into `skip` would permanently drop a slice whose predecessor',
    'merely has not finished. Treat `wait` as "come back after the current wave".',
    '',
    'Decisions are threaded forward within one call, so a slice gated on a slice this',
    'pass skipped is reported as `skip` too rather than waiting on a status that will',
    'never change. When slices are waiting, nothing is runnable and nothing is in',
    'progress, `plan` reports `stalled` and exits non-zero — no later re-evaluation',
    'can change that answer, so a caller that looped would loop forever.',
    '',
    'Condition shape in roadmap.yaml (requires schema_version 3):',
    '',
    '  slices:',
    '    - id: S001',
    '      name: migrate',
    '    - id: S002',
    '      name: verify the migration',
    '      when:',
    '        slice: S001',
    '        status: done',
    '',
    'Operators: status | status_not. A bare list of terms means all of them must',
    'hold; use all_of / any_of to be explicit. References must name a slice in the',
    'same milestone — cross-milestone ordering is the milestone depends_on field.',
    '',
    'An unresolvable condition is an error, never a run. A gate that opens when it',
    'breaks is not a gate, so a milestone with a broken condition is refused rather',
    'than executed with the gate ignored.',
  ].join('\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const cwd = context.cwd || process.cwd();
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    stdout.write(_usage() + '\n');
    return args.length === 0 ? 1 : 0;
  }

  const verb = args[0];
  const rest = args.slice(1);
  const asJson = rest.includes('--json');

  try {
    const parsed = parseRoadmap(cwd);

    if (verb === 'lint') {
      const res = sc.lintDocument(parsed.doc);
      if (asJson) {
        stdout.write(JSON.stringify(res, null, 2) + '\n');
      } else if (res.ok) {
        stdout.write('ok: every slice condition parses and resolves\n');
      } else {
        for (const f of res.findings) {
          stderr.write('[slice-plan] ' + (f.milestone || '?') + '/' + (f.slice || '?')
            + ' ' + f.code + ': ' + f.message + '\n');
        }
      }
      return res.ok ? 0 : 1;
    }

    if (verb === 'plan') {
      const n = getFlag(rest, '--milestone') || rest.find((a) => !a.startsWith('--'));
      if (n === undefined) {
        stderr.write(JSON.stringify({
          code: 'slice-plan-missing-milestone',
          message: 'plan requires a milestone number',
          details: {},
        }) + '\n');
        return 1;
      }
      const node = _findPhaseTarget(parsed.doc, String(n));
      if (!node) {
        stderr.write(JSON.stringify({
          code: 'slice-plan-milestone-not-found',
          message: 'Milestone ' + n + ' is not in roadmap.yaml',
          details: { milestone: String(n) },
        }) + '\n');
        return 1;
      }

      const plan = sc.planMilestone(node);
      if (asJson) {
        stdout.write(JSON.stringify(plan, null, 2) + '\n');
      } else {
        for (const s of plan.slices) {
          stdout.write(s.decision.padEnd(6, ' ') + ' ' + s.id
            + (s.conditional ? '  (' + s.reason + ')' : '') + '\n');
        }
      }
      for (const e of plan.errors) {
        stderr.write('[slice-plan] ' + e.slice + ' ' + e.code + ': ' + e.message + '\n');
      }
      if (plan.stalled) {
        // Reported as an error, not as information. The caller's contract for
        // `wait` is "come back after the current wave", and there is no current
        // wave — so leaving this at exit 0 hands the orchestrator a loop with no
        // exit condition and silently drops the waiting slices.
        stderr.write(JSON.stringify({
          code: 'slice-plan-stalled',
          message: plan.stall_reason,
          details: { waiting: plan.waiting, skipped: plan.skipped, milestone: String(n) },
        }) + '\n');
      }
      // Non-zero on an unevaluable condition: the milestone is not executable
      // until the plan is fixed, and the caller must not proceed as if it were.
      return plan.ok && !plan.stalled ? 0 : 1;
    }

    stderr.write(JSON.stringify({
      code: 'slice-plan-unknown-verb',
      message: 'Unknown verb: ' + verb,
      details: { verb, allowed: ['plan', 'lint'] },
    }) + '\n');
    return 1;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'slice-plan-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

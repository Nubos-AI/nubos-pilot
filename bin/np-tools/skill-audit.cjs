'use strict';

const nubosloop = require('../../lib/nubosloop.cjs');
const checkpoint = require('../../lib/checkpoint.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const args = require('./_args.cjs');
const { NubosPilotError } = require('../../lib/core.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs skill-audit expect   --task <id> --skills <a,b,c>   (orchestrator: record injected skills)',
    '  np-tools.cjs skill-audit ack      --task <id> --skill <name>     (executor: stamp a consulted skill)',
    '  np-tools.cjs skill-audit findings --task <id> [--round <n>]      (read-only: list unmet skill bars)',
    '',
    'Mechanical counterpart to the Rule-9 search audit: a skill injected as a task\'s',
    'quality bar that the executor never consulted becomes a `skill-bar-unconsulted`',
    'finding at post-critics, routing the task back to the executor (once per round).',
  ].join('\n');
}

function _assertTask(taskId) {
  args.assertMatch(taskId, TASK_ID_RE, 'skill-audit-invalid-task-id', 'taskId');
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const list = Array.isArray(argv) ? argv : [];
  const verb = list[0];
  const tail = list.slice(1);

  if (!verb || verb === '-h' || verb === '--help') { stdout.write(_usage() + '\n'); return 0; }

  try {
    if (verb === 'expect') {
      const taskId = args.getFlag(tail, '--task');
      _assertTask(taskId);
      const raw = args.getFlag(tail, '--skills') || '';
      const skills = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      const res = nubosloop.recordExpectedSkills(taskId, skills, cwd);
      stdout.write(JSON.stringify(res) + '\n');
      return 0;
    }
    if (verb === 'ack') {
      const taskId = args.getFlag(tail, '--task');
      _assertTask(taskId);
      const skill = args.getFlag(tail, '--skill');
      if (!skill) throw new NubosPilotError('skill-audit-missing-skill', 'ack requires --skill <name>', {});
      const res = nubosloop.recordSkillEvidence(taskId, skill, cwd);
      stdout.write(JSON.stringify(res) + '\n');
      return 0;
    }
    if (verb === 'findings') {
      const taskId = args.getFlag(tail, '--task');
      _assertTask(taskId);
      const cp = checkpoint.readCheckpoint(taskId, cwd) || {};
      const prev = cp.nubosloop || {};
      const roundArg = args.getFlag(tail, '--round');
      const round = roundArg != null ? Number(roundArg) : (Number(prev.round) || 1);
      const findings = nubosloop.skillFindingsFromState(prev, round, taskId);
      stdout.write(JSON.stringify({ task_id: taskId, round, findings }) + '\n');
      return 0;
    }
    stderr.write(JSON.stringify({ code: 'skill-audit-unknown-verb', message: 'Unknown verb: ' + verb, details: { verb, verbs: ['expect', 'ack', 'findings'] } }) + '\n');
    return 1;
  } catch (err) {
    args.emitErrorEnvelope(err, stderr, 'skill-audit-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(3)));
}

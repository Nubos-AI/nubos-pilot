'use strict';

const checkpoint = require('../../lib/checkpoint.cjs');
const nubosloop = require('../../lib/nubosloop.cjs');
const agentsLib = require('../../lib/agents.cjs');
const args = require('./_args.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const taskId = list[0];
  args.assertMatch(taskId, TASK_ID_RE, 'loop-audit-invalid-task-id', 'taskId');
  const tail = list.slice(1);

  if (tail.includes('--read')) {
    const log = nubosloop.readToolUseAudit(taskId, cwd) || [];
    stdout.write(JSON.stringify({ task_id: taskId, audit: log }) + '\n');
    return { task_id: taskId, audit: log };
  }

  const agent = args.getFlag(tail, '--agent');
  if (!agent) {
    throw new (require('../../lib/core.cjs').NubosPilotError)(
      'loop-audit-missing-agent',
      'loop-audit-tool-use requires --agent <name> (or --read for read-only)',
      { hint: 'agents requiring search tools: ' + nubosloop.AUDITED_AGENTS.join(', ') },
    );
  }
  if (typeof agent === 'string' && agent.startsWith('np-')) {
    try {
      agentsLib.loadAgentModule(agent, cwd);
      throw new (require('../../lib/core.cjs').NubosPilotError)(
        'loop-audit-agent-is-module',
        'loop-audit-tool-use refuses to record a spawn for "' + agent + '": this agent is a module (module: true) and cannot be spawned independently',
        { agent, hint: 'Modules are loaded as <files_to_read> by their parent agent. Spawn the parent and audit that name instead.' },
      );
    } catch (err) {
      if (!err) throw err;
      if (err.code === 'loop-audit-agent-is-module') throw err;
    }
  }
  const isAuditedAgent = nubosloop.AUDITED_AGENTS.includes(agent);
  let log;
  if (tail.includes('--tool-use-log')) {
    log = args.getJsonFlag(
      tail,
      '--tool-use-log',
      'loop-audit-missing-log',
      "JSON array of tool-name strings, e.g. '[\"Read\",\"knowledge-search\",\"Edit\"]'",
    );
    if (!Array.isArray(log)) {
      throw new (require('../../lib/core.cjs').NubosPilotError)(
        'loop-audit-invalid-log',
        '--tool-use-log must be a JSON array',
        { got: typeof log },
      );
    }
  } else if (isAuditedAgent) {
    throw new (require('../../lib/core.cjs').NubosPilotError)(
      'loop-audit-missing-log',
      'loop-audit-tool-use requires --tool-use-log for audited agent: ' + agent,
      { hint: 'audited agents drive Rule 9 enforcement; pass --tool-use-log \'[]\' to record an empty spawn' },
    );
  } else {
    log = [];
  }
  const result = nubosloop.auditToolUse(taskId, agent, log, cwd);
  const payload = { task_id: taskId, ...result };
  stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

module.exports = { run };

const path = require('node:path');
const { NubosPilotError } = require('../../lib/core.cjs');
const { resolveGate } = require('../../lib/next.cjs');
const { findPhaseDir } = require('../../lib/phase.cjs');
const { listPlans } = require('../../lib/plan.cjs');
const { loadTaskGraph } = require('../../lib/tasks.cjs');

function _firstWaveAllSkippedOrParked(phaseN, cwd) {
  let phaseDir;
  try { phaseDir = findPhaseDir(phaseN, cwd); } catch { return false; }
  if (!phaseDir) return false;
  const plans = listPlans(phaseDir);
  if (plans.length === 0) return false;
  const planDir = path.dirname(plans[0]);
  let tg;
  try { tg = loadTaskGraph(planDir); } catch { return false; }
  if (!tg.waves || tg.waves.length === 0) return false;
  const firstWave = tg.waves[0];
  const pending = firstWave
    .map((id) => tg.tasks.find((t) => t.id === id))
    .filter((t) => t && t.frontmatter && t.frontmatter.status !== 'done');
  if (pending.length === 0) return false;
  return pending.every((t) => t.frontmatter.status === 'skipped' || t.frontmatter.status === 'parked');
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];

  
  const verb = list[0];
  const phaseArg = verb === 'init' ? list[1] : verb;
  if (phaseArg == null || phaseArg === '' || !/^\d+(\.\d+)?$/.test(String(phaseArg))) {
    throw new NubosPilotError(
      'autonomous-invalid-phase',
      'autonomous requires a numeric phase argument',
      { value: phaseArg == null ? '' : String(phaseArg) },
    );
  }
  const phaseN = Number(phaseArg);
  const gate = resolveGate(phaseN, cwd);
  let payload;
  const blockedNullTask = gate.rule === 3 && !gate.task;
  const blockedSkippedOnly = gate.rule === 3 && _firstWaveAllSkippedOrParked(phaseN, cwd);
  if (blockedNullTask || blockedSkippedOnly) {

    
    payload = {
      _workflow: 'autonomous',
      status: 'advancement-blocked',
      phase: phaseN,
      reason: 'rule-3-null-task',
      gate,
    };
  } else {
    payload = {
      _workflow: 'autonomous',
      status: 'ok',
      phase: phaseN,
      gate,
    };
  }
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

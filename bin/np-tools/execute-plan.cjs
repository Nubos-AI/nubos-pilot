const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  NubosPilotError,
  projectStateDir,
} = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');
const { listPlans, parsePlan } = require('../../lib/plan.cjs');
const { loadTaskGraph } = require('../../lib/tasks.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;
const PLAN_ID_RE = /^\d{2}-\d{2}$/;

function _safeSkills(name, cwd) {
  try { return getAgentSkills(name, cwd); } catch { return []; }
}

function _emit(payload, stdout, cwd) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= INLINE_THRESHOLD_BYTES) {
    stdout.write(json);
    return;
  }
  let tmpDir;
  try {
    tmpDir = path.join(projectStateDir(cwd), '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch { tmpDir = os.tmpdir(); }
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-execute-plan-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _resolvePhaseDir(n, cwd, slug) {
  const hit = findPhaseDir(n, cwd);
  if (hit) return hit;
  const padded = paddedPhase(n);
  let stateDir;
  try { stateDir = projectStateDir(cwd); } catch { stateDir = path.join(path.resolve(cwd), '.nubos-pilot'); }
  return path.join(stateDir, 'phases', padded + '-' + slug);
}

function _initPayload(planId, cwd) {
  const [phaseStr, planStr] = planId.split('-');
  const phaseNum = Number(phaseStr);
  const phase = getPhase(phaseNum, cwd);
  const padded = paddedPhase(phaseNum);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseNum, cwd, slug);
  const all = listPlans(phase_dir);
  const target = all.find((p) => path.basename(p) === `${planId}-PLAN.md`);
  if (!target) {
    throw new NubosPilotError(
      'execute-plan-not-found',
      'Plan ' + planId + ' not found in phase ' + phaseNum,
      { planId, phase: phaseNum, searched: all },
    );
  }
  const parsed = parsePlan(target);
  const planDir = path.dirname(target);
  const tg = loadTaskGraph(planDir);
  return {
    _workflow: 'execute-plan',
    plan_id: planId,
    phase: phaseStr,
    padded,
    plan_number: planStr,
    phase_dir,
    phase_name: phase.name,
    plan_path: target,
    plan_frontmatter: parsed.frontmatter,
    tasks_dir: path.join(planDir, 'tasks'),
    task_count: tg.tasks.length,
    waves: tg.waves,
    warnings: tg.warnings,
    executor_tier: 'sonnet',
    agent_skills: { executor: _safeSkills('np-executor', cwd) },
  };
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init': {
      const planId = list[1];
      if (!planId) {
        throw new NubosPilotError(
          'execute-plan-missing-id',
          'execute-plan requires a plan id (e.g. 06-01)',
          {},
        );
      }
      if (!PLAN_ID_RE.test(planId)) {
        throw new NubosPilotError(
          'execute-plan-invalid-id',
          'Invalid plan id format: ' + planId + ' (expected NN-NN)',
          { planId },
        );
      }
      const payload = _initPayload(planId, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    default:
      throw new NubosPilotError(
        'execute-plan-unknown-verb',
        'execute-plan: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };

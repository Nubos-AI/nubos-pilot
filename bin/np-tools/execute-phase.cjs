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
const { loadTaskGraph, TASK_ID_RE } = require('../../lib/tasks.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'execute-phase-invalid-phase-arg',
      'execute-phase requires a phase number',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new NubosPilotError(
      'execute-phase-invalid-phase-arg',
      'Invalid phase number: ' + s,
      { value: s },
    );
  }
  return s;
}

function _resolvePhaseDir(n, cwd, slug) {
  const hit = findPhaseDir(n, cwd);
  if (hit) return hit;
  const padded = paddedPhase(n);
  let stateDir;
  try { stateDir = projectStateDir(cwd); } catch { stateDir = path.join(path.resolve(cwd), '.nubos-pilot'); }
  return path.join(stateDir, 'phases', padded + '-' + slug);
}

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
  const tmpPath = path.join(tmpDir, 'init-execute-phase-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _initPayload(phaseArg, cwd) {
  const phase = getPhase(phaseArg, cwd);
  const padded = paddedPhase(phaseArg);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const plans = [];
  let planPaths = [];
  try { planPaths = listPlans(phase_dir); } catch { planPaths = []; }
  for (const planPath of planPaths) {
    const parsed = parsePlan(planPath);
    const planDir = path.dirname(planPath);
    const tg = loadTaskGraph(planDir);
    plans.push({
      plan_path: planPath,
      plan_frontmatter: parsed.frontmatter,
      tasks_dir: path.join(planDir, 'tasks'),
      task_count: tg.tasks.length,
      waves: tg.waves,
      warnings: tg.warnings,
    });
  }
  return {
    _workflow: 'execute-phase',
    phase: phaseArg,
    padded,
    phase_dir,
    phase_name: phase.name,
    phase_slug: slug,
    goal: phase.goal || '',
    requirements: Array.isArray(phase.requirements) ? phase.requirements : [],
    success_criteria: Array.isArray(phase.success_criteria) ? phase.success_criteria : [],
    plans,
    executor_tier: 'sonnet',
    agent_skills: { executor: _safeSkills('np-executor', cwd) },
  };
}

function _findTaskPayload(phaseArg, taskId, cwd) {
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'execute-phase-invalid-task-id',
      'Invalid task id: ' + taskId,
      { taskId },
    );
  }
  const phase = getPhase(phaseArg, cwd);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const planPaths = listPlans(phase_dir);
  for (const planPath of planPaths) {
    const planDir = path.dirname(planPath);
    const taskFile = path.join(planDir, 'tasks', taskId + '.md');
    if (!fs.existsSync(taskFile)) continue;
    const { frontmatter, body } = extractFrontmatter(fs.readFileSync(taskFile, 'utf-8'));
    return {
      _workflow: 'execute-phase',
      verb: 'execute-task',
      phase: phaseArg,
      task_id: taskId,
      task_file: taskFile,
      plan_path: planPath,
      files_modified: Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [],
      task_name: frontmatter.name || (String(body || '').match(/^#\s+(?:Task:\s*)?(.+?)\s*$/m) || [null, taskId])[1],
      wave: frontmatter.wave,
      tier: frontmatter.tier || 'sonnet',
      depends_on: Array.isArray(frontmatter.depends_on) ? frontmatter.depends_on : [],
      executor_tier: 'sonnet',
      agent_skills: { executor: _safeSkills('np-executor', cwd) },
    };
  }
  throw new NubosPilotError(
    'execute-phase-task-not-found',
    'Task ' + taskId + ' not found under phase ' + phaseArg,
    { taskId, phase: phaseArg },
  );
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init': {
      const phaseArg = _validatePhaseArg(list[1]);
      const payload = _initPayload(phaseArg, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    case 'execute-task': {
      const phaseArg = _validatePhaseArg(list[1]);
      const taskId = list[2];
      if (!taskId) {
        throw new NubosPilotError(
          'execute-phase-missing-task-id',
          'execute-task requires <task-id>',
          {},
        );
      }
      const payload = _findTaskPayload(phaseArg, taskId, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    default:
      throw new NubosPilotError(
        'execute-phase-unknown-verb',
        'execute-phase: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _parseArgs(args) {
  const rest = [];
  const flags = { assumptions: false };
  for (const a of args || []) {
    if (a === '--assumptions') flags.assumptions = true;
    else rest.push(a);
  }
  return { positional: rest, flags };
}

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'discuss-invalid-phase-arg',
      'discuss-phase requires a phase number (integer or decimal like 7.1)',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  const integerOk = /^\d+$/.test(s);
  const decimalOk = /^\d+\.\d+$/.test(s);
  if (!integerOk && !decimalOk) {
    throw new NubosPilotError(
      'discuss-invalid-phase-arg',
      'Invalid phase number: ' + s,
      { value: s },
    );
  }
  return s;
}

function _agentSkills() {
  try {
    const agents = require('../../lib/agents.cjs');
    if (typeof agents.getAgentSkills === 'function') {
      return { planner: agents.getAgentSkills('np-planner') };
    }
  } catch (_err) {  }
  return { planner: null };
}

function _resolvePhaseDir(n, cwd, slug) {
  const hit = findPhaseDir(n, cwd);
  if (hit) return hit;

  

  const padded = paddedPhase(n);
  let stateDir;
  try { stateDir = projectStateDir(cwd); } catch (_err) {
    stateDir = path.join(path.resolve(cwd), '.nubos-pilot');
  }
  return path.join(stateDir, 'phases', padded + '-' + slug);
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
  } catch (_err) {
    tmpDir = os.tmpdir();
  }
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-discuss-phase-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const { positional, flags } = _parseArgs(args);
  const phaseArg = _validatePhaseArg(positional[0]);

  let phase;
  try {
    phase = getPhase(phaseArg, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'discuss-phase-not-found',
        'Phase ' + phaseArg + ' not found in roadmap.yaml',
        { number: phaseArg },
      );
    }
    throw err;
  }

  const padded = paddedPhase(phaseArg);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const contextPath = path.join(phase_dir, padded + '-CONTEXT.md');
  const has_context = fs.existsSync(contextPath);

  const payload = {
    _workflow: 'discuss-phase',
    phase_number: phaseArg,
    padded,
    phase_dir,
    phase_name: phase.name,
    phase_slug: slug,
    has_context,
    goal: phase.goal || '',
    requirements: Array.isArray(phase.requirements) ? phase.requirements : [],
    success_criteria: Array.isArray(phase.success_criteria) ? phase.success_criteria : [],
    mode: flags.assumptions ? 'assumptions' : 'adaptive',
    agent_skills: _agentSkills(),
  };

  _emit(payload, stdout, cwd);
  return payload;
}

module.exports = { run, _parseArgs, _validatePhaseArg, INLINE_THRESHOLD_BYTES };

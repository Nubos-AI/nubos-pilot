const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _parsePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'research-invalid-phase-arg',
      'research-phase requires a phase number argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new NubosPilotError(
      'research-invalid-phase-arg',
      'research-phase argument must be a non-negative integer',
      { value: String(raw) },
    );
  }
  return n;
}

function _paddedPhase(n) {
  return String(n).padStart(2, '0');
}

function _findPhaseDir(cwd, padded) {

  
  let phasesRoot;
  try {
    phasesRoot = path.join(projectStateDir(cwd), 'phases');
  } catch (err) {
    if (!err || err.code !== 'not-in-project') throw err;
    phasesRoot = path.join(path.resolve(cwd), '.planning', 'phases');
  }
  try {
    const entries = fs.readdirSync(phasesRoot, { withFileTypes: true });
    const hit = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find((name) => name === padded || name.startsWith(padded + '-'));
    if (hit) return path.join(phasesRoot, hit);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  

  return path.join(phasesRoot, padded);
}

function _readRoadmapPhase(cwd, phaseNumber) {
  const { getPhase } = require('../../lib/roadmap.cjs');
  try {
    return getPhase(phaseNumber, cwd);
  } catch (err) {
    if (err && err.name === 'NubosPilotError' && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'research-phase-not-found',
        'Phase ' + phaseNumber + ' not found in roadmap',
        { number: phaseNumber },
      );
    }
    throw err;
  }
}

function _toolsAvailable() {
  return {
    WebFetch: process.env.NP_TOOLS_WEBFETCH === '1',
    Context7: process.env.NP_TOOLS_CONTEXT7 === '1',
  };
}

function _agentSkills(cwd) {
  try {
    const agents = require('../../lib/agents.cjs');
    if (typeof agents.getAgentSkills === 'function') {
      return { researcher: agents.getAgentSkills('np-researcher', cwd) };
    }
  } catch (_err) {  }
  return { researcher: null };
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
  const tmpPath = path.join(tmpDir, 'init-research-phase-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;

  const phase = _parsePhaseArg((args || [])[0]);
  const padded = _paddedPhase(phase);
  const phaseInfo = _readRoadmapPhase(cwd, phase);
  const phase_dir = _findPhaseDir(cwd, padded);

  const researchPath = path.join(phase_dir, padded + '-RESEARCH.md');
  let has_research = false;
  try {
    has_research = fs.statSync(researchPath).isFile();
  } catch (_err) { has_research = false; }

  const payload = {
    _workflow: 'research-phase',
    phase,
    padded,
    phase_dir,
    goal: phaseInfo.goal || '',
    requirements: Array.isArray(phaseInfo.requirements)
      ? phaseInfo.requirements.slice()
      : [],
    has_research,
    tools_available: _toolsAvailable(),
    agent_skills: _agentSkills(cwd),
  };
  _emit(payload, stdout, cwd);
  return payload;
}

module.exports = { run, INLINE_THRESHOLD_BYTES, _parsePhaseArg };

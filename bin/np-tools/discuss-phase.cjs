'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const layout = require('../../lib/layout.cjs');

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

function _validateMilestoneArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'discuss-invalid-phase-arg',
      'discuss-phase requires a milestone number (integer)',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+$/.test(s)) {
    throw new NubosPilotError(
      'discuss-invalid-phase-arg',
      'Invalid milestone number (must be positive integer): ' + s,
      { value: s },
    );
  }
  return Number(s);
}

function _agentSkills() {
  try {
    const agents = require('../../lib/agents.cjs');
    if (typeof agents.getAgentSkills === 'function') {
      return { planner: agents.getAgentSkills('np-planner') };
    }
  } catch (_err) { /* skills optional */ }
  return { planner: null };
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
  const mNum = _validateMilestoneArg(positional[0]);

  let def;
  try {
    def = getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'discuss-phase-not-found',
        'Milestone ' + mNum + ' not found in roadmap.yaml',
        { number: mNum },
      );
    }
    throw err;
  }

  const mIdStr = layout.mId(mNum);
  const milestoneDir = layout.milestoneDir(mNum, cwd);
  const contextPath = layout.milestoneContextPath(mNum, cwd);
  const has_context = fs.existsSync(contextPath);
  const has_milestone_dir = fs.existsSync(milestoneDir);

  const payload = {
    _workflow: 'discuss-phase',
    milestone: mNum,
    milestone_id: mIdStr,
    milestone_dir: milestoneDir,
    milestone_name: def.name,
    milestone_context_path: contextPath,
    has_context,
    has_milestone_dir,
    goal: def.goal || '',
    requirements: Array.isArray(def.requirements) ? def.requirements : [],
    success_criteria: Array.isArray(def.success_criteria) ? def.success_criteria : [],
    mode: flags.assumptions ? 'assumptions' : 'adaptive',
    agent_skills: _agentSkills(),
  };

  _emit(payload, stdout, cwd);
  return payload;
}

module.exports = { run, _parseArgs, _validateMilestoneArg, INLINE_THRESHOLD_BYTES };

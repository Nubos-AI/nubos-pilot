'use strict';

const fs = require('node:fs');

const { NubosPilotError } = require('../../lib/core.cjs');
const { emitInitPayload } = require('../../lib/init-emit.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const layout = require('../../lib/layout.cjs');
const textMode = require('../../lib/text-mode.cjs');

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

  const tmDetail = textMode.resolveTextModeDetail(cwd);

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
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: _agentSkills(),
  };

  emitInitPayload(payload, stdout, cwd, 'discuss-phase');
  return payload;
}

module.exports = { run, _parseArgs, _validateMilestoneArg };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');
const layout = require('../../lib/layout.cjs');
const textMode = require('../../lib/text-mode.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _parseMilestoneArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'research-invalid-phase-arg',
      'research-phase requires a milestone number argument',
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

function _readMilestoneDef(cwd, mNum) {
  const { getPhase } = require('../../lib/roadmap.cjs');
  try {
    return getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.name === 'NubosPilotError' && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'research-phase-not-found',
        'Milestone ' + mNum + ' not found in roadmap',
        { number: mNum },
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
  } catch (_err) { /* optional */ }
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

  const mNum = _parseMilestoneArg((args || [])[0]);
  const def = _readMilestoneDef(cwd, mNum);
  const mIdStr = layout.mId(mNum);
  const mDir = layout.milestoneDir(mNum, cwd);
  const researchPath = path.join(mDir, mIdStr + '-RESEARCH.md');

  let has_research = false;
  try { has_research = fs.statSync(researchPath).isFile(); }
  catch (_err) { has_research = false; }

  const slices = layout.listSlices(mNum, cwd);
  const sliceResearch = slices.map((s) => {
    const p = layout.sliceResearchPath(mNum, s.number, cwd);
    return {
      id: s.id,
      full_id: s.full_id,
      path: p,
      has_research: fs.existsSync(p),
    };
  });

  const tmDetail = textMode.resolveTextModeDetail(cwd);

  const payload = {
    _workflow: 'research-phase',
    milestone: mNum,
    milestone_id: mIdStr,
    milestone_dir: mDir,
    milestone_research_path: researchPath,
    goal: def.goal || '',
    requirements: Array.isArray(def.requirements) ? def.requirements.slice() : [],
    has_research,
    slice_research: sliceResearch,
    tools_available: _toolsAvailable(),
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: _agentSkills(cwd),
  };
  _emit(payload, stdout, cwd);
  return payload;
}

module.exports = { run, INLINE_THRESHOLD_BYTES, _parseMilestoneArg };

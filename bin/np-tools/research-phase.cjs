'use strict';

const fs = require('node:fs');

const { NubosPilotError } = require('../../lib/core.cjs');
const { emitInitPayload } = require('../../lib/init-emit.cjs');
const layout = require('../../lib/layout.cjs');
const textMode = require('../../lib/text-mode.cjs');
const { DEFAULT_RESEARCH_TOOLS } = require('../../lib/config-defaults.cjs');
const swarm = require('../../lib/researcher-swarm.cjs');
const knowledgeAdapter = require('../../lib/knowledge-adapter.cjs');

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

function _readConfigResearchTools(cwd) {
  const { tryReadConfigPath } = require('../../lib/config.cjs');
  const rt = tryReadConfigPath(cwd, 'workflow.research_tools', {});
  return rt && typeof rt === 'object' && !Array.isArray(rt) ? rt : {};
}

function _resolveToolFlag(envValue, configValue, defaultValue) {
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;
  if (typeof configValue === 'boolean') return configValue;
  return defaultValue;
}

function _toolsAvailable(cwd) {
  const cfg = _readConfigResearchTools(cwd);
  return {
    WebFetch: _resolveToolFlag(process.env.NP_TOOLS_WEBFETCH, cfg.WebFetch, DEFAULT_RESEARCH_TOOLS.WebFetch),
    Context7: _resolveToolFlag(process.env.NP_TOOLS_CONTEXT7, cfg.Context7, DEFAULT_RESEARCH_TOOLS.Context7),
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


async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;

  const mNum = _parseMilestoneArg((args || [])[0]);
  const def = _readMilestoneDef(cwd, mNum);
  const mIdStr = layout.mId(mNum);
  const mDir = layout.milestoneDir(mNum, cwd);
  const researchPath = layout.milestoneResearchPath(mNum, cwd);

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

  const swarmOpts = swarm.resolveSwarmOpts(cwd);
  const spawnSpecs = swarm.buildSpawnSpecs({ milestone: mNum, milestone_id: mIdStr, goal: def.goal || '' }, swarmOpts.k, { cwd });

  let cacheHit = null;
  let cacheMiss = null;
  const SOFT_CACHE_FAILURES = new Set(['knowledge-adapter-unknown']);
  try {
    const adapter = knowledgeAdapter.getAdapter(cwd);
    const queryParts = [def.goal || '', mIdStr];
    if (Array.isArray(def.requirements)) queryParts.push(def.requirements.join(' '));
    const query = queryParts.filter(Boolean).join(' ');
    if (query) {
      const m = await adapter.match(query, {
        threshold: swarmOpts.threshold,
        minOccurrence: swarmOpts.minOccurrence,
      });
      if (m && m.best) {
        cacheHit = {
          adapter: adapter.name,
          fingerprint: m.best.fingerprint,
          pattern: m.best.pattern,
          outcome: m.best.outcome,
          occurrence: m.best.occurrence,
          similarity: m.best.similarity,
        };
      }
    }
  } catch (err) {
    if (err && err.name === 'NubosPilotError' && SOFT_CACHE_FAILURES.has(err.code)) {
      cacheMiss = { code: err.code, message: err.message };
    } else {
      throw err;
    }
  }

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
    tools_available: _toolsAvailable(cwd),
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: _agentSkills(cwd),
    swarm: {
      k: swarmOpts.k,
      threshold: swarmOpts.threshold,
      min_occurrence: swarmOpts.minOccurrence,
      spawn_specs: spawnSpecs,
      cache_hit: cacheHit,
      cache_miss_reason: cacheMiss,
      bypass_swarm: cacheHit !== null,
    },
  };
  emitInitPayload(payload, stdout, cwd, 'research-phase');
  return payload;
}

module.exports = { run, _parseMilestoneArg, _toolsAvailable, _resolveToolFlag };

const fs = require('node:fs');
const path = require('node:path');
const { mutateState, readState } = require('./state.cjs');
const { parseRoadmap } = require('./roadmap.cjs');
const { findPhaseDir } = require('./phase.cjs');
const { listPlans } = require('./plan.cjs');
const { NubosPilotError } = require('./core.cjs');

function _zeroProgress() {
  return { total_phases: 0, completed_phases: 0, total_plans: 0, completed_plans: 0, percent: 0 };
}

function _phaseDirFor(n, cwd) {
  try { return findPhaseDir(n, cwd); }
  catch (err) {
    if (err && err.code === 'not-in-project') return null;
    return null;
  }
}

function _computeFromRoadmap(cwd) {
  let roadmap;
  try { roadmap = parseRoadmap(cwd); }
  catch (err) {
    if (err && err.code === 'roadmap-parse-error') return _zeroProgress();
    throw err;
  }
  const phases = roadmap.phases || [];
  let totalPhases = phases.length;
  let completedPhases = 0;
  let totalPlans = 0;
  let completedPlans = 0;
  for (const ph of phases) {
    if (ph.complete) completedPhases += 1;

    const dir = _phaseDirFor(Number(ph.number), cwd);
    let plansCount = 0;
    if (dir) {

      let onDisk = [];
      try { onDisk = listPlans(dir); } catch { onDisk = []; }
      plansCount = onDisk.length;
    }
    if (plansCount === 0) {
      plansCount = Array.isArray(ph.plans) ? ph.plans.length : 0;
    }
    totalPlans += plansCount;

    if (Array.isArray(ph.plans)) {
      for (const p of ph.plans) if (p && p.complete) completedPlans += 1;
    }
  }
  const percent = totalPhases === 0 ? 0 : Math.round((completedPhases / totalPhases) * 100);
  return {
    total_phases: totalPhases,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    completed_plans: completedPlans,
    percent,
  };
}

function recomputeProgress(cwd = process.cwd()) {
  const computed = _computeFromRoadmap(cwd);
  try {
    mutateState((cur) => {
      return { ...cur, frontmatter: { ...cur.frontmatter, progress: computed } };
    }, cwd);
  } catch (err) {

    if (err && err.code && String(err.code).startsWith('ENOENT')) return computed;
    if (err && err.message && /ENOENT/.test(err.message)) return computed;
    throw err;
  }
  return computed;
}

function readProgress(cwd = process.cwd()) {
  try {
    const s = readState(cwd);
    const p = s && s.frontmatter && s.frontmatter.progress;
    if (p && typeof p === 'object') return p;
    return _zeroProgress();
  } catch (err) {
    if (err && err.code && String(err.code).startsWith('ENOENT')) return _zeroProgress();
    if (err && err.message && /ENOENT/.test(err.message)) return _zeroProgress();
    throw new NubosPilotError(
      'progress-read-error',
      `readProgress failed: ${err && err.message}`,
      { cause: err && err.code },
    );
  }
}

module.exports = { recomputeProgress, readProgress };

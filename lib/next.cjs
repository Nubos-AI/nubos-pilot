const fs = require('node:fs');
const path = require('node:path');
const { readState } = require('./state.cjs');
const { parseRoadmap } = require('./roadmap.cjs');
const { findPhaseDir, paddedPhase } = require('./phase.cjs');
const { listPlans } = require('./plan.cjs');
const { loadTaskGraph } = require('./tasks.cjs');
const { NubosPilotError } = require('./core.cjs');

function _safeReadState(cwd) {
  try {
    return readState(cwd);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;

    if (err && typeof err === 'object' && err.code === 'schema-version-mismatch') throw err;

    if (err && err.code && String(err.code).startsWith('ENOENT')) return null;

    if (err && err.message && /ENOENT/.test(err.message)) return null;
    throw err;
  }
}

function _safeParseRoadmap(cwd) {
  try {
    return parseRoadmap(cwd);
  } catch (err) {
    if (err && err.code === 'roadmap-parse-error') return null;
    throw err;
  }
}

function _firstPendingPhase(roadmap) {
  if (!roadmap || !Array.isArray(roadmap.phases) || roadmap.phases.length === 0) return null;
  for (const p of roadmap.phases) {
    if (!p.complete) return Number(p.number);
  }
  return null;
}

function _phaseDirFor(n, cwd) {
  try {
    return findPhaseDir(n, cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;

    return null;
  }
}

function _hasContext(phaseDir, n) {
  if (!phaseDir) return false;
  const padded = paddedPhase(n);
  return fs.existsSync(path.join(phaseDir, padded + '-CONTEXT.md'));
}

function _hasVerification(phaseDir, n) {
  if (!phaseDir) return false;
  const padded = paddedPhase(n);
  return fs.existsSync(path.join(phaseDir, padded + '-VERIFICATION.md'));
}

function _phasePlanPaths(phaseDir) {
  if (!phaseDir) return [];
  return listPlans(phaseDir);
}

function _firstPendingTaskPointer(phaseDir) {
  const plans = _phasePlanPaths(phaseDir);
  if (plans.length === 0) return null;

  const planDir = path.dirname(plans[0]);
  let tg;
  try {
    tg = loadTaskGraph(planDir);
  } catch (err) {

    
    return null;
  }
  if (!tg.tasks || tg.tasks.length === 0) return null;
  if (!tg.waves || tg.waves.length === 0) return null;
  const firstWaveIds = tg.waves[0];
  const pendingInWave = firstWaveIds
    .map((id) => tg.tasks.find((t) => t.id === id))
    .filter((t) => t && t.frontmatter && t.frontmatter.status !== 'done')
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  if (pendingInWave.length === 0) return null;
  const pick = pendingInWave[0];
  return {
    id: pick.frontmatter.id,
    owner: pick.frontmatter.owner,
    tier: pick.frontmatter.tier,
    wave: typeof pick.frontmatter.wave === 'number' ? pick.frontmatter.wave : 1,
  };
}

function _allTasksDone(phaseDir) {
  const plans = _phasePlanPaths(phaseDir);
  if (plans.length === 0) return false;
  for (const planPath of plans) {
    const planDir = path.dirname(planPath);
    let tg;
    try { tg = loadTaskGraph(planDir); }
    catch { return false; }
    if (!tg.tasks || tg.tasks.length === 0) return false;
    for (const t of tg.tasks) {
      if (!t.frontmatter || t.frontmatter.status !== 'done') return false;
    }
  }
  return true;
}

function resolveGate(phaseN, cwd) {
  const phaseDir = _phaseDirFor(phaseN, cwd);
  if (!_hasContext(phaseDir, phaseN)) return { rule: 1 };
  const plans = _phasePlanPaths(phaseDir);
  if (plans.length === 0) return { rule: 2 };
  if (!_allTasksDone(phaseDir)) {
    const task = _firstPendingTaskPointer(phaseDir);
    return { rule: 3, task };
  }
  if (!_hasVerification(phaseDir, phaseN)) return { rule: 4 };
  return { rule: 5 };
}

function _shapeForRule(gate, n) {
  switch (gate.rule) {
    case 1:
      return {
        next_step: { command: `/np:discuss-phase ${n}`, reason: `Phase ${n} has no CONTEXT.md` },
        task: null,
        phase: n,
        plan: null,
      };
    case 2:
      return {
        next_step: { command: `/np:plan-phase ${n}`, reason: `Phase ${n} has CONTEXT.md but no PLAN.md yet` },
        task: null,
        phase: n,
        plan: null,
      };
    case 3: {
      const task = gate.task || null;
      const planFromTask = task && task.id ? task.id.slice(0, 5) : null;
      return {
        next_step: { command: `/np:execute-phase ${n}`, reason: `Phase ${n} has pending tasks` },
        task,
        phase: n,
        plan: planFromTask,
      };
    }
    case 4:
      return {
        next_step: { command: `/np:verify-work ${n}`, reason: `Phase ${n} tasks all done — awaiting verification` },
        task: null,
        phase: n,
        plan: null,
      };
    default:
      return null;
  }
}

function computeNextStep(cwd = process.cwd()) {
  try {
    const roadmap = _safeParseRoadmap(cwd);

    if (!roadmap) {
      return _shapeForRule({ rule: 1 }, 1);
    }

    
    let phaseN;
    const state = _safeReadState(cwd);
    const cur = state && state.frontmatter ? state.frontmatter.current_phase : null;
    if (cur != null && Number.isFinite(Number(cur))) {
      phaseN = Number(cur);
    } else {
      const first = _firstPendingPhase(roadmap);
      if (first == null) {

        return {
          next_step: { command: '/np:complete-milestone', reason: 'All phases complete' },
          task: null,
          phase: null,
          plan: null,
        };
      }
      phaseN = first;
    }

    const gate = resolveGate(phaseN, cwd);
    if (gate.rule !== 5) {
      return _shapeForRule(gate, phaseN);
    }

    const idx = roadmap.phases.findIndex((p) => Number(p.number) === phaseN);
    let nextPending = null;
    for (let i = idx + 1; i < roadmap.phases.length; i++) {
      if (!roadmap.phases[i].complete) {
        nextPending = Number(roadmap.phases[i].number);
        break;
      }
    }
    if (nextPending == null) {
      return {
        next_step: { command: '/np:complete-milestone', reason: 'All phases complete' },
        task: null,
        phase: null,
        plan: null,
      };
    }

    const gate2 = resolveGate(nextPending, cwd);
    if (gate2.rule === 5) {

      
      return {
        next_step: { command: `/np:plan-phase ${nextPending}`, reason: 'Next phase ready for planning' },
        task: null, phase: nextPending, plan: null,
      };
    }
    return _shapeForRule(gate2, nextPending);
  } catch (err) {
    if (err && err.code) throw err;
    throw new NubosPilotError(
      'next-internal-error',
      `computeNextStep failed: ${err && err.message}`,
      { cause: err && err.message },
    );
  }
}

module.exports = { computeNextStep, resolveGate };

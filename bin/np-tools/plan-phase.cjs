const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  NubosPilotError,
  projectStateDir,
  findProjectRoot,
  atomicWriteFileSync,
  withFileLock,
} = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');
const { listPlans, parsePlan, shouldPromoteToTasks } = require('../../lib/plan.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');
const { gitShowSafe } = require('../../lib/git.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'plan-phase-invalid-phase-arg',
      'plan-phase requires a phase number (integer or decimal)',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new NubosPilotError(
      'plan-phase-invalid-phase-arg',
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
  const tmpPath = path.join(tmpDir, 'init-plan-phase-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _initPayload(phaseArg, cwd) {
  let phase;
  try {
    phase = getPhase(phaseArg, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'plan-phase-not-found',
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
  const researchPath = path.join(phase_dir, padded + '-RESEARCH.md');
  const plan_review_path = path.join(phase_dir, padded + '-PLAN-REVIEW.md');

  let has_plan = false;
  try { has_plan = listPlans(phase_dir).length > 0; } catch { has_plan = false; }

  const { plan_diff_required, plan_diff_plan_path } = _probePlanDiff(phase_dir, padded, cwd);

  return {
    _workflow: 'plan-phase',
    phase: phaseArg,
    padded,
    phase_dir,
    phase_slug: slug,
    phase_name: phase.name,
    goal: phase.goal || '',
    requirements: Array.isArray(phase.requirements) ? phase.requirements : [],
    success_criteria: Array.isArray(phase.success_criteria) ? phase.success_criteria : [],
    has_context: fs.existsSync(contextPath),
    has_research: fs.existsSync(researchPath),
    has_plan,
    context_path: fs.existsSync(contextPath) ? contextPath : null,
    research_path: fs.existsSync(researchPath) ? researchPath : null,
    plan_review_path,
    planner_tier: 'opus',
    checker_tier: 'opus',
    plan_diff_required,
    plan_diff_plan_path,
    agent_skills: {
      'np-planner': _safeSkills('np-planner', cwd),
      'np-plan-checker': _safeSkills('np-plan-checker', cwd),
    },
  };
}

function _probePlanDiff(phaseDir, padded, cwd) {
  const firstPlanAbs = path.join(phaseDir, padded + '-01-PLAN.md');
  let root;
  try { root = findProjectRoot(cwd); } catch { root = path.resolve(cwd); }
  const rel = path.relative(root, firstPlanAbs);
  const prev = process.cwd();
  process.chdir(root);
  let prior = null;
  try {
    prior = gitShowSafe('HEAD', rel);
  } catch {
    prior = null;
  } finally {
    process.chdir(prev);
  }
  return {
    plan_diff_required: prior !== null,
    plan_diff_plan_path: rel,
  };
}

function _readVerdict(verdictPath) {
  let raw;
  try {
    raw = fs.readFileSync(verdictPath, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'plan-phase-verdict-unreadable',
      'Verdict file not readable: ' + verdictPath,
      { path: verdictPath, cause: err && err.code },
    );
  }
  try { return JSON.parse(raw); } catch (err) {
    throw new NubosPilotError(
      'plan-phase-verdict-invalid',
      'Verdict file is not valid JSON',
      { path: verdictPath, cause: err && err.message },
    );
  }
}

function _renderVerdictYaml(verdict) {
  const status = verdict.status || 'unknown';
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const lines = ['status: ' + status, 'findings:'];
  if (findings.length === 0) {
    lines[1] = 'findings: []';
  } else {
    for (const f of findings) {
      lines.push('  - category: ' + (f.category || 'unknown'));
      lines.push('    severity: ' + (f.severity || 'minor'));
      if (f.target) lines.push('    target: ' + JSON.stringify(String(f.target)));
      if (f.message) lines.push('    message: ' + JSON.stringify(String(f.message)));
    }
  }
  return lines.join('\n');
}

function _renderIterationSection(iter, verdict) {
  const ts = new Date().toISOString();
  const status = verdict.status || 'unknown';
  const parts = [
    '',
    '## Iteration ' + iter + ' - ' + ts,
    '',
    '**Planner output:** PLAN.md committed at pending',
    '**Checker verdict:** ' + status,
    '**Findings:**',
    '',
    '```yaml',
    _renderVerdictYaml(verdict),
    '```',
    '',
    '**Planner response:** ' + (status === 'passed' ? 'done' : 'revision'),
    '',
  ];
  return parts.join('\n');
}

function _planReviewAppend(phaseArg, iter, verdictPath, cwd) {
  const padded = paddedPhase(phaseArg);
  const phase = getPhase(phaseArg, cwd);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  fs.mkdirSync(phase_dir, { recursive: true });
  const reviewPath = path.join(phase_dir, padded + '-PLAN-REVIEW.md');
  const verdict = _readVerdict(verdictPath);

  return withFileLock(reviewPath, () => {
    let existing = '';
    try { existing = fs.readFileSync(reviewPath, 'utf-8'); } catch { existing = ''; }
    if (existing === '') {
      existing = '# PLAN-REVIEW.md — Phase ' + phaseArg + ' (' + phase.name + ')\n'
        + '\nAppend-only audit trail of plan-checker iterations. Never truncate.\n';
    }
    const section = _renderIterationSection(iter, verdict);
    const next = existing + section;
    atomicWriteFileSync(reviewPath, next);
    return { appended: true, path: reviewPath, iteration: Number(iter) };
  });
}

function _rmRecursive(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {  }
}

function _planPhaseAbort(phaseArg, cwd) {
  const padded = paddedPhase(phaseArg);
  const phase = getPhase(phaseArg, cwd);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const removed = [];

  let entries = [];
  try { entries = fs.readdirSync(phase_dir); } catch { entries = []; }
  for (const name of entries) {
    if (name === 'PLAN.md' || /^\d{2}(\.\d+)?-\d{2}-PLAN\.md$/.test(name)) {
      const p = path.join(phase_dir, name);
      _rmRecursive(p);
      removed.push(p);
    }
  }
  const tasksDir = path.join(phase_dir, 'tasks');
  if (fs.existsSync(tasksDir)) {
    _rmRecursive(tasksDir);
    removed.push(tasksDir);
  }

  const preserved = path.join(phase_dir, padded + '-PLAN-REVIEW.md');
  return { aborted: true, removed, preserved: fs.existsSync(preserved) ? preserved : null };
}

function _extractTasksFromPlan(planPath) {

  
  const raw = fs.readFileSync(planPath, 'utf-8');
  const tagRe = /<task\s+([^>]+?)(?:\/>|>[\s\S]*?<\/task>)/g;
  const attrRe = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = tagRe.exec(raw)) !== null) {
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const depsRaw = attrs.depends_on || '';
    const deps = depsRaw
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      id: attrs.id || '',
      frontmatter: {
        depends_on: deps,
        wave: attrs.wave ? Number(attrs.wave) : undefined,
        tier: attrs.tier || undefined,
      },
    });
  }
  return out;
}

function _planPhasePromoteCheck(phaseArg, cwd) {
  const phase = getPhase(phaseArg, cwd);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const plans = listPlans(phase_dir);
  if (plans.length === 0) return { promote: false, triggers: [] };

  
  const planPath = plans[0];

  parsePlan(planPath);
  const tasks = _extractTasksFromPlan(planPath);
  return shouldPromoteToTasks({ tasks });
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
    case 'plan-review-append': {
      const phaseArg = _validatePhaseArg(list[1]);
      const iter = list[2];
      const verdictPath = list[3];
      if (!iter || !verdictPath) {
        throw new NubosPilotError(
          'plan-phase-missing-args',
          'plan-review-append requires <phase> <iter> <verdictJsonPath>',
          { got: list.slice(1) },
        );
      }
      const result = _planReviewAppend(phaseArg, iter, verdictPath, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'plan-phase-abort': {
      const phaseArg = _validatePhaseArg(list[1]);
      const result = _planPhaseAbort(phaseArg, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'plan-phase-promote-check': {
      const phaseArg = _validatePhaseArg(list[1]);
      const result = _planPhasePromoteCheck(phaseArg, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    default:
      throw new NubosPilotError(
        'plan-phase-unknown-verb',
        'plan-phase: unknown verb: ' + String(verb),
        { verb: verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };

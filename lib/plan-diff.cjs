const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError, findProjectRoot, projectStateDir, atomicWriteFileSync } = require('./core.cjs');
const { TASK_ID_RE } = require('./tasks.cjs');
const { gitShowSafe, gitDiffNoColor, checkoutFromHead } = require('./git.cjs');

const SEMANTIC_HEADER = '── Semantic diff (task-level) ──────────────────────────────';
const RAW_HEADER      = '── Raw git diff (full text) ────────────────────────────────';

const PHASE_RE = /^\d+(\.\d+)?$/;
const PLAN_ID_RE = /^\d{2}(\.\d+)?-\d{2}$/;

function _scanTasks(body) {
  const out = new Map();
  const re = /<task\b[^>]*?tier=["']([^"']+)["'][^>]*?id=["']([^"']+)["']|<task\b[^>]*?id=["']([^"']+)["'][^>]*?tier=["']([^"']+)["']/g;
  for (const m of String(body).matchAll(re)) {
    const id = m[2] || m[3];
    const tier = m[1] || m[4];
    if (id && TASK_ID_RE.test(id)) {
      out.set(id, { id, tier: tier || 'unknown' });
    }
  }
  return out;
}

function semanticTaskDiff(priorBody, currentBody) {
  const prior = _scanTasks(priorBody || '');
  const cur = _scanTasks(currentBody || '');
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, rec] of cur) {
    if (!prior.has(id)) {
      added.push(rec);
    } else {
      const p = prior.get(id);
      if (p.tier !== rec.tier && p.tier !== 'unknown' && rec.tier !== 'unknown') {
        changed.push({ id, field: 'tier', from: p.tier, to: rec.tier });
      }
    }
  }
  for (const [id, rec] of prior) {
    if (!cur.has(id)) removed.push(rec);
  }
  return { added, removed, changed };
}

function _renderSemantic(diff) {
  const lines = [];
  for (const a of diff.added) lines.push('+ ' + a.id + ': tier=' + a.tier);
  for (const c of diff.changed) lines.push('~ ' + c.id + ': ' + c.field + '=' + c.from + '→' + c.to);
  for (const r of diff.removed) lines.push('- ' + r.id);
  return lines.length ? lines.join('\n') : '(no task-level changes detected)';
}

function _validatePhaseArg(phase) {
  if (typeof phase !== 'string' || !PHASE_RE.test(phase)) {
    throw new NubosPilotError(
      'plan-diff-invalid-phase',
      'Invalid phase argument: ' + String(phase),
      { phase: String(phase) },
    );
  }
}

function _validatePlanId(planId) {
  if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) {
    throw new NubosPilotError(
      'plan-diff-invalid-plan-id',
      'Invalid plan-id argument: ' + String(planId),
      { planId: String(planId) },
    );
  }
}

function _planPathForIds(phase, planId, cwd) {
  _validatePhaseArg(phase);
  _validatePlanId(planId);
  let root;
  try {
    root = findProjectRoot(cwd || process.cwd());
  } catch {
    root = path.resolve(cwd || process.cwd());
  }
  const phasesRoot = path.join(projectStateDir(root), 'phases');
  const padded = String(phase).padStart(2, '0');
  let phaseDirName = null;
  try {
    const entries = fs.readdirSync(phasesRoot, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.isDirectory())
      .filter((e) => e.name === padded || e.name.startsWith(padded + '-'))
      .map((e) => e.name)
      .sort((a, b) => b.length - a.length);
    if (matches.length > 0) phaseDirName = matches[0];
  } catch {
    phaseDirName = null;
  }
  if (!phaseDirName) {
    throw new NubosPilotError(
      'plan-diff-phase-not-found',
      'No phase directory starting with ' + padded + ' under ' + phasesRoot,
      { phase, phasesRoot },
    );
  }
  const phaseDir = path.join(phasesRoot, phaseDirName);
  const planFile = planId + '-PLAN.md';
  const relative = path.relative(root, path.join(phaseDir, planFile));
  return {
    absolute: path.join(phaseDir, planFile),
    relative,
    phaseDir,
    phaseDirName,
    root,
    padded,
  };
}

function renderTwoPartDiff({ phase, planId, cwd }) {
  const resolved = _planPathForIds(phase, planId, cwd);
  const prev = process.cwd();
  process.chdir(resolved.root);
  try {
    const prior = gitShowSafe('HEAD', resolved.relative);
    if (prior === null) return { hasPrior: false };
    const current = fs.existsSync(resolved.absolute)
      ? fs.readFileSync(resolved.absolute, 'utf-8')
      : '';
    const diff = semanticTaskDiff(prior, current);
    const semantic = _renderSemantic(diff);
    const raw = gitDiffNoColor('HEAD', resolved.relative);
    const combined = [SEMANTIC_HEADER, '', semantic, '', RAW_HEADER, '', raw].join('\n');
    return { hasPrior: true, semantic, raw, combined };
  } finally {
    process.chdir(prev);
  }
}

function restoreFromHead({ phase, planId, cwd }) {
  const resolved = _planPathForIds(phase, planId, cwd);
  checkoutFromHead([resolved.relative], { cwd: resolved.root });
}

function archiveRejected({ phase, planId, reason, cwd }) {
  const resolved = _planPathForIds(phase, planId, cwd);
  const body = fs.existsSync(resolved.absolute)
    ? fs.readFileSync(resolved.absolute, 'utf-8')
    : '';
  const iso = new Date().toISOString();
  const safeIso = iso.replace(/:/g, '-');
  const archiveName = resolved.padded + '-' + planId + '-PLAN-DIFF-' + safeIso + '.md';
  const archivePath = path.join(resolved.phaseDir, archiveName);
  const content = [
    '---',
    'rejected_at: ' + iso,
    'reason: ' + JSON.stringify(reason == null ? '' : String(reason)),
    '---',
    '',
    body,
  ].join('\n');
  atomicWriteFileSync(archivePath, content);
  restoreFromHead({ phase, planId, cwd });
  return archivePath;
}

module.exports = {
  semanticTaskDiff,
  renderTwoPartDiff,
  archiveRejected,
  restoreFromHead,
  SEMANTIC_HEADER,
  RAW_HEADER,
};

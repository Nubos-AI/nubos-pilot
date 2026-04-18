const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { parseRoadmap } = require('../../lib/roadmap.cjs');
const { readState } = require('../../lib/state.cjs');
const { aggregatePhase } = require('../../lib/metrics-aggregate.cjs');

const SCHEMA_VERSION = 1;

function _usage() {
  return 'Usage:\n  np-tools.cjs stats json';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'stats-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function _safeExec(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (_err) {
    return '';
  }
}

function _gitStats(cwd) {
  const log = _safeExec(['log', '--oneline', '--all'], cwd);
  const commits = log ? log.split(/\r?\n/).filter((l) => l.length > 0).length : 0;
  const first = _safeExec(['log', '--reverse', '--format=%aI', '--all'], cwd);
  const firstFirst = first ? first.split(/\r?\n/)[0] : '';
  return { commits, first_commit_at: firstFirst || null };
}

function _milestoneEntry(doc) {
  if (!doc || !Array.isArray(doc.milestones) || doc.milestones.length === 0) return null;
  const active = doc.milestones.find((m) => m && m.status === 'active' && m.id !== 'backlog');
  const nonBacklog = doc.milestones.filter((m) => m && m.id !== 'backlog');
  const pick = active || nonBacklog[0] || doc.milestones[0];
  if (!pick) return null;
  return { version: pick.id || '', name: pick.name || '' };
}

function _collectPhases(doc) {
  const out = [];
  if (!doc || !Array.isArray(doc.milestones)) return out;
  for (const ms of doc.milestones) {
    if (!ms || !Array.isArray(ms.phases)) continue;
    if (ms.id === 'backlog') continue;
    for (const ph of ms.phases) {
      if (!ph || ph.number == null) continue;
      const plans = Array.isArray(ph.plans) ? ph.plans : [];
      const completePlans = plans.filter((p) => p && p.complete === true).length;
      const status = ph.status === 'done' || ph.status === 'complete'
        ? 'complete'
        : ph.status === 'in-progress' ? 'in-progress' : 'pending';
      out.push({
        number: String(ph.number),
        name: ph.name || '',
        plans_total: plans.length,
        plans_complete: completePlans,
        status,
        requirements: Array.isArray(ph.requirements) ? ph.requirements.slice() : [],
      });
    }
  }
  return out;
}

async function _buildStats(cwd) {
  const useCwd = cwd || process.cwd();
  const roadmap = parseRoadmap(useCwd);
  const doc = roadmap && roadmap.doc ? roadmap.doc : null;
  const milestone = _milestoneEntry(doc);
  const phases = _collectPhases(doc);
  let plansTotal = 0;
  let plansComplete = 0;
  for (const ph of phases) {
    plansTotal += ph.plans_total;
    plansComplete += ph.plans_complete;
  }
  const percent = plansTotal > 0 ? Math.round((plansComplete / plansTotal) * 100) : 0;
  let lastActivity = null;
  try {
    const st = readState(useCwd);
    if (st && st.frontmatter && st.frontmatter.last_activity) {
      lastActivity = String(st.frontmatter.last_activity);
    }
  } catch (_err) {
    lastActivity = null;
  }
  const git = _gitStats(useCwd);
  const metrics_by_phase = {};
  for (const ph of phases) {
    try {
      const agg = await aggregatePhase(ph.number, { cwd: useCwd });
      metrics_by_phase[ph.number] = agg;
    } catch (_err) {
      metrics_by_phase[ph.number] = null;
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    milestone,
    phases,
    plans_total: plansTotal,
    plans_complete: plansComplete,
    percent,
    git,
    last_activity: lastActivity,
    metrics_by_phase,
  };
}

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const sub = args.shift();
  if (sub !== 'json') {
    stderr.write(_usage() + '\n');
    return 1;
  }
  try {
    findProjectRoot(cwd);
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
  try {
    const out = await _buildStats(cwd);
    stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _buildStats, _collectPhases, _milestoneEntry };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

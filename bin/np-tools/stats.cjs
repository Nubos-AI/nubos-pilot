const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { parseRoadmap } = require('../../lib/roadmap.cjs');
const { readState } = require('../../lib/state.cjs');
const { aggregatePhase } = require('../../lib/metrics-aggregate.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { resolveLanguage } = require('../../lib/language.cjs');
const layout = require('../../lib/layout.cjs');

const SCHEMA_VERSION = 2;

const MD_LABELS = Object.freeze({
  en: {
    title: '## Project Stats',
    milestone: '**Milestone:**',
    progress: '**Progress:**',
    plans: 'plans',
    last_activity: '**Last activity:**',
    commits: '**Commits:**',
    started: '**Project started:**',
    phases_h: '### Phases',
    metrics_h: '### Metrics by Phase',
    cols_phases: '| Phase | Name | Plans | Completed | Status | % |',
    sep_phases:  '|-------|------|-------|-----------|--------|---|',
    cols_metrics: '| Phase | Records | Tokens In | Tokens Out | Avg Opus ms | Avg Sonnet ms | Avg Haiku ms | Errors |',
    sep_metrics:  '|-------|---------|-----------|------------|-------------|---------------|--------------|--------|',
  },
  de: {
    title: '## Projekt-Stats',
    milestone: '**Milestone:**',
    progress: '**Fortschritt:**',
    plans: 'Pläne',
    last_activity: '**Letzte Aktivität:**',
    commits: '**Commits:**',
    started: '**Projekt-Start:**',
    phases_h: '### Phasen',
    metrics_h: '### Metriken pro Phase',
    cols_phases: '| Phase | Name | Pläne | Fertig | Status | % |',
    sep_phases:  '|-------|------|-------|--------|--------|---|',
    cols_metrics: '| Phase | Records | Tokens In | Tokens Out | Ø Opus ms | Ø Sonnet ms | Ø Haiku ms | Fehler |',
    sep_metrics:  '|-------|---------|-----------|------------|-----------|-------------|------------|--------|',
  },
});

function _mdLabelsFor(language) {
  return MD_LABELS[language === 'de' ? 'de' : 'en'];
}

function _usage() {
  return 'Usage:\n  np-tools.cjs stats json\n  np-tools.cjs stats bar\n  np-tools.cjs stats markdown';
}

function _percent(num, den) {
  if (!den || den <= 0) return 0;
  return Math.min(100, Math.round((num / den) * 100));
}

function _taskStatus(planPath) {
  try {
    const raw = fs.readFileSync(planPath, 'utf-8');
    const { frontmatter } = extractFrontmatter(raw);
    return frontmatter && typeof frontmatter.status === 'string'
      ? frontmatter.status : null;
  } catch {
    return null;
  }
}

function _collectTaskAndSliceStats(cwd) {
  let tasksTotal = 0;
  let tasksComplete = 0;
  let slicesTotal = 0;
  let slicesComplete = 0;
  const milestones = layout.listMilestones(cwd);
  for (const m of milestones) {
    const slices = layout.listSlices(m.number, cwd);
    for (const s of slices) {
      slicesTotal += 1;
      const tasks = layout.listTasks(m.number, s.number, cwd);
      if (tasks.length === 0) continue;
      let doneInSlice = 0;
      for (const t of tasks) {
        if (!fs.existsSync(t.plan_path)) continue;
        tasksTotal += 1;
        if (_taskStatus(t.plan_path) === 'done') {
          tasksComplete += 1;
          doneInSlice += 1;
        }
      }
      if (doneInSlice === tasks.length && tasks.length > 0) slicesComplete += 1;
    }
  }
  return {
    tasks: {
      total: tasksTotal,
      complete: tasksComplete,
      percent: _percent(tasksComplete, tasksTotal),
    },
    slices: {
      total: slicesTotal,
      complete: slicesComplete,
      percent: _percent(slicesComplete, slicesTotal),
    },
  };
}

function _renderBar(label, percent, width) {
  const w = Math.max(4, Math.min(60, width || 24));
  const filled = Math.round((percent / 100) * w);
  const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
  return label + ' [' + bar + '] ' + String(percent).padStart(3, ' ') + '%';
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
  const percent = _percent(plansComplete, plansTotal);
  const fs_progress = _collectTaskAndSliceStats(useCwd);
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
    tasks: fs_progress.tasks,
    slices: fs_progress.slices,
    git,
    last_activity: lastActivity,
    metrics_by_phase,
  };
}

function _fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

function _renderMarkdown(stats, language) {
  const L = _mdLabelsFor(language);
  const filled = Math.round((stats.percent || 0) / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const lines = [];
  lines.push(L.title);
  lines.push('');
  lines.push(L.milestone + ' ' + _fmt(stats.milestone && stats.milestone.version) + ' — ' + _fmt(stats.milestone && stats.milestone.name));
  lines.push(L.progress + ' [' + bar + '] ' + (stats.percent || 0) + '% (' + stats.plans_complete + '/' + stats.plans_total + ' ' + L.plans + ')');
  lines.push(L.last_activity + ' ' + _fmt(stats.last_activity));
  lines.push(L.commits + ' ' + _fmt(stats.git && stats.git.commits));
  lines.push(L.started + ' ' + _fmt(stats.git && stats.git.first_commit_at));
  lines.push('');
  lines.push(L.phases_h);
  lines.push('');
  lines.push(L.cols_phases);
  lines.push(L.sep_phases);
  for (const ph of (stats.phases || [])) {
    const pct = ph.plans_total > 0 ? Math.round(ph.plans_complete / ph.plans_total * 100) : 0;
    lines.push('| ' + ph.number + ' | ' + ph.name + ' | ' + ph.plans_total + ' | ' + ph.plans_complete + ' | ' + ph.status + ' | ' + pct + '% |');
  }
  lines.push('');
  lines.push(L.metrics_h);
  lines.push('');
  lines.push(L.cols_metrics);
  lines.push(L.sep_metrics);
  for (const ph of (stats.phases || [])) {
    const m = (stats.metrics_by_phase || {})[ph.number];
    if (!m || m.record_count === 0) {
      lines.push('| ' + ph.number + ' | — | — | — | — | — | — | — |');
      continue;
    }
    const t = m.avg_duration_ms_by_tier || {};
    lines.push('| ' + ph.number + ' | ' + m.record_count + ' | ' + _fmt(m.total_tokens_in) + ' | ' + _fmt(m.total_tokens_out) + ' | ' + _fmt(t.opus) + ' | ' + _fmt(t.sonnet) + ' | ' + _fmt(t.haiku) + ' | ' + m.error_count + ' |');
  }
  return lines.join('\n') + '\n';
}

function _resolveLangForCwd(cwd) {
  try { return resolveLanguage(cwd || process.cwd()); }
  catch { return 'en'; }
}

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const sub = args.shift();
  if (sub !== 'json' && sub !== 'bar' && sub !== 'markdown') {
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
    if (sub === 'bar') {
      stdout.write(_renderBar('Tasks ', out.tasks.percent) + '  (' + out.tasks.complete + '/' + out.tasks.total + ')\n');
      stdout.write(_renderBar('Slices', out.slices.percent) + '  (' + out.slices.complete + '/' + out.slices.total + ')\n');
      return 0;
    }
    if (sub === 'markdown') {
      let lang = null;
      const langIdx = args.indexOf('--lang');
      if (langIdx >= 0 && args[langIdx + 1]) lang = args[langIdx + 1];
      else for (const a of args) if (a.startsWith('--lang=')) lang = a.slice('--lang='.length);
      const language = lang || _resolveLangForCwd(cwd);
      stdout.write(_renderMarkdown(out, language));
      return 0;
    }
    stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _buildStats, _collectPhases, _milestoneEntry, _collectTaskAndSliceStats, _renderBar, _renderMarkdown, MD_LABELS };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

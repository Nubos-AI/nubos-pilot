'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter } = require('./frontmatter.cjs');
const { listMilestones, listSlices, listTasks, mId } = require('./layout.cjs');
const { normalizeLanguage, DEFAULT_LANGUAGE } = require('./language.cjs');
const nubosloop = require('./nubosloop.cjs');

const LABELS = Object.freeze({
  en: {
    done: 'done',
    'in-progress': 'in-progress',
    pending: 'pending',
    skipped: 'skipped',
    parked: 'parked',
    no_tasks: 'no tasks',
    no_slices: 'no slices planned',
    no_milestones: 'No milestones yet. Run /np:new-project or /np:new-milestone.',
  },
  de: {
    done: 'erledigt',
    'in-progress': 'in Arbeit',
    pending: 'offen',
    skipped: 'übersprungen',
    parked: 'geparkt',
    no_tasks: 'keine Tasks',
    no_slices: 'keine Slices geplant',
    no_milestones: 'Noch keine Milestones. Führe /np:new-project oder /np:new-milestone aus.',
  },
});

function _labelsFor(language) {
  const lang = normalizeLanguage(language || DEFAULT_LANGUAGE);
  return LABELS[lang] || LABELS[DEFAULT_LANGUAGE];
}

const ANSI = Object.freeze({
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
});

const STATUS_GLYPHS = Object.freeze({
  'pending':     { glyph: '[ ]', color: ANSI.gray },
  'in-progress': { glyph: '[~]', color: ANSI.yellow },
  'done':        { glyph: '[x]', color: ANSI.green },
  'skipped':     { glyph: '[-]', color: ANSI.dim },
  'parked':      { glyph: '[!]', color: ANSI.red },
});

function _safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

function _safeReadFile(p) {
  try { return fs.readFileSync(p, 'utf-8'); }
  catch { return null; }
}

const _STATUS_CACHE = new Map();
const _STATUS_CACHE_MAX = 2000;

function _taskStatus(planPath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(planPath).mtimeMs; }
  catch { return 'pending'; }
  const cached = _STATUS_CACHE.get(planPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    _STATUS_CACHE.delete(planPath);
    _STATUS_CACHE.set(planPath, cached);
    return cached.status;
  }
  const raw = _safeReadFile(planPath);
  let status = 'pending';
  if (raw) {
    try {
      const { frontmatter } = extractFrontmatter(raw);
      if (typeof frontmatter.status === 'string') status = frontmatter.status;
    } catch { /* keep default */ }
  }
  _STATUS_CACHE.set(planPath, { mtimeMs, status });
  if (_STATUS_CACHE.size > _STATUS_CACHE_MAX) {
    const oldest = _STATUS_CACHE.keys().next().value;
    _STATUS_CACHE.delete(oldest);
  }
  return status;
}

function _collectMilestones(projectRoot) {
  const out = [];
  for (const m of listMilestones(projectRoot)) {
    const meta = _safeReadJson(path.join(m.path, mId(m.number) + '-META.json')) || {};
    const slices = [];
    for (const s of listSlices(m.number, projectRoot)) {
      const tasks = listTasks(m.number, s.number, projectRoot);
      const counts = { total: 0, pending: 0, 'in-progress': 0, done: 0, skipped: 0, parked: 0 };
      const statuses = [];
      for (const t of tasks) {
        const status = _taskStatus(t.plan_path);
        statuses.push(status);
        counts.total += 1;
        if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
      }
      slices.push({
        id: s.id,
        full_id: s.full_id,
        counts,
        task_statuses: statuses,
      });
    }
    out.push({
      id: m.id,
      number: m.number,
      name: typeof meta.name === 'string' ? meta.name : null,
      status: typeof meta.status === 'string' ? meta.status : null,
      slices,
    });
  }
  return out;
}

function collectSnapshot(projectRoot) {
  const cwd = projectRoot || process.cwd();
  let loopMetrics;
  try { loopMetrics = nubosloop.aggregateLoopMetrics(cwd); }
  catch { loopMetrics = null; }
  return {
    milestones: _collectMilestones(cwd),
    nubosloop: loopMetrics,
  };
}

function _summarizeCounts(c, useColor, labels) {
  const paint = (code, text) => useColor ? code + text + ANSI.reset : text;
  const bits = [];
  if (c.done)           bits.push(paint(ANSI.green,  c.done           + ' ' + labels.done));
  if (c['in-progress']) bits.push(paint(ANSI.yellow, c['in-progress'] + ' ' + labels['in-progress']));
  if (c.pending)        bits.push(paint(ANSI.gray,   c.pending        + ' ' + labels.pending));
  if (c.skipped)        bits.push(paint(ANSI.dim,    c.skipped        + ' ' + labels.skipped));
  if (c.parked)         bits.push(paint(ANSI.red,    c.parked         + ' ' + labels.parked));
  return bits.join(' · ') || paint(ANSI.dim, labels.no_tasks);
}

function _checkboxRow(statuses, useColor) {
  const parts = [];
  for (const s of statuses) {
    const g = STATUS_GLYPHS[s] || STATUS_GLYPHS.pending;
    parts.push(useColor ? g.color + g.glyph + ANSI.reset : g.glyph);
  }
  return parts.join(' ');
}

function renderSnapshot(snap, opts) {
  const o = opts || {};
  const useColor = o.color !== false;
  const labels = _labelsFor(o.language);
  const c = (code, text) => useColor ? code + text + ANSI.reset : text;
  const lines = [];

  lines.push(c(ANSI.bold + ANSI.blue, 'nubos-pilot'));
  lines.push('');

  if (!snap.milestones || snap.milestones.length === 0) {
    lines.push(c(ANSI.dim, labels.no_milestones));
    lines.push('');
  }

  for (const m of (snap.milestones || [])) {
    const name = m.name ? ' — ' + m.name : '';
    const status = m.status ? '  ' + c(ANSI.dim, '[' + m.status + ']') : '';
    lines.push(c(ANSI.bold, m.id) + name + status);
    if (m.slices.length === 0) {
      lines.push('  ' + c(ANSI.dim, labels.no_slices));
    }
    for (const s of m.slices) {
      lines.push('  ' + c(ANSI.bold, s.full_id) + '  ' + _summarizeCounts(s.counts, useColor, labels));
      if (s.task_statuses.length > 0) {
        lines.push('  ' + _checkboxRow(s.task_statuses, useColor));
      }
    }
    lines.push('');
  }

  if (snap.nubosloop && snap.nubosloop.tasks_with_loop > 0) {
    const pb = snap.nubosloop;
    lines.push(c(ANSI.bold + ANSI.blue, 'Nubosloop'));
    lines.push(
      '  tasks: ' + pb.tasks_with_loop +
      '  · avg rounds: ' + pb.average_rounds +
      '  · commits: ' + c(ANSI.green, String(pb.commit_count)) +
      '  · stuck: ' + (pb.stuck_count > 0 ? c(ANSI.red + ANSI.bold, String(pb.stuck_count)) : c(ANSI.dim, '0'))
    );
    const top = Object.entries(pb.finding_categories || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (top.length) {
      lines.push('  top findings: ' + top.map(([cat, n]) => cat + '×' + n).join(' · '));
    }
    if (pb.stuck_count > 0) {
      lines.push('  ' + c(ANSI.red + ANSI.bold, '⚠ ' + pb.stuck_count + ' task(s) stuck — review checkpoints + run /np:resume-work'));
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  collectSnapshot,
  renderSnapshot,
  ANSI,
  STATUS_GLYPHS,
  LABELS,
};

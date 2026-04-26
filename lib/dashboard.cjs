'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter } = require('./frontmatter.cjs');
const { listMilestones, listSlices, listTasks, mId } = require('./layout.cjs');

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

function _taskStatus(planPath) {
  const raw = _safeReadFile(planPath);
  if (!raw) return 'pending';
  try {
    const { frontmatter } = extractFrontmatter(raw);
    return typeof frontmatter.status === 'string' ? frontmatter.status : 'pending';
  } catch { return 'pending'; }
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
  return { milestones: _collectMilestones(cwd) };
}

function _summarizeCounts(c, useColor) {
  const paint = (code, text) => useColor ? code + text + ANSI.reset : text;
  const bits = [];
  if (c.done)           bits.push(paint(ANSI.green,  c.done           + ' done'));
  if (c['in-progress']) bits.push(paint(ANSI.yellow, c['in-progress'] + ' in-progress'));
  if (c.pending)        bits.push(paint(ANSI.gray,   c.pending        + ' pending'));
  if (c.skipped)        bits.push(paint(ANSI.dim,    c.skipped        + ' skipped'));
  if (c.parked)         bits.push(paint(ANSI.red,    c.parked         + ' parked'));
  return bits.join(' · ') || paint(ANSI.dim, 'no tasks');
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
  const c = (code, text) => useColor ? code + text + ANSI.reset : text;
  const lines = [];

  lines.push(c(ANSI.bold + ANSI.blue, 'nubos-pilot'));
  lines.push('');

  if (!snap.milestones || snap.milestones.length === 0) {
    lines.push(c(ANSI.dim, 'No milestones yet. Run /np:new-project or /np:new-milestone.'));
    lines.push('');
    return lines.join('\n');
  }

  for (const m of snap.milestones) {
    const name = m.name ? ' — ' + m.name : '';
    const status = m.status ? '  ' + c(ANSI.dim, '[' + m.status + ']') : '';
    lines.push(c(ANSI.bold, m.id) + name + status);
    if (m.slices.length === 0) {
      lines.push('  ' + c(ANSI.dim, 'no slices planned'));
    }
    for (const s of m.slices) {
      lines.push('  ' + c(ANSI.bold, s.full_id) + '  ' + _summarizeCounts(s.counts, useColor));
      if (s.task_statuses.length > 0) {
        lines.push('  ' + _checkboxRow(s.task_statuses, useColor));
      }
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
};

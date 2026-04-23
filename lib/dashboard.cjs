'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter } = require('./frontmatter.cjs');
const { projectStateDir } = require('./core.cjs');
const { listMilestones, listSlices, listTasks, mId, sId } = require('./layout.cjs');
const { listHandoffs } = require('./handoff.cjs');
const { listSliceWorktrees, worktreeIsolationEnabled } = require('./worktree.cjs');
const { workspaceGitInfo } = require('./git.cjs');

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
  clearScreen: '\x1b[2J\x1b[H',
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

function _collectMilestones(projectRoot) {
  const out = [];
  for (const m of listMilestones(projectRoot)) {
    const meta = _safeReadJson(path.join(m.path, mId(m.number) + '-META.json')) || {};
    const slices = [];
    for (const s of listSlices(m.number, projectRoot)) {
      const tasks = listTasks(m.number, s.number, projectRoot);
      const counts = { total: 0, pending: 0, 'in-progress': 0, done: 0, skipped: 0, parked: 0 };
      for (const t of tasks) {
        const raw = _safeReadFile(t.plan_path);
        if (!raw) continue;
        let fm;
        try { ({ frontmatter: fm } = extractFrontmatter(raw)); } catch { fm = {}; }
        const status = typeof fm.status === 'string' ? fm.status : 'pending';
        counts.total += 1;
        if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
      }
      slices.push({
        id: s.id,
        full_id: s.full_id,
        path: s.path,
        counts,
        tasks_statuses: tasks.map((t) => {
          const raw = _safeReadFile(t.plan_path);
          if (!raw) return 'pending';
          try { return extractFrontmatter(raw).frontmatter.status || 'pending'; }
          catch { return 'pending'; }
        }),
      });
    }
    out.push({
      id: m.id,
      number: m.number,
      name: (meta && typeof meta.name === 'string') ? meta.name : null,
      status: (meta && typeof meta.status === 'string') ? meta.status : null,
      slices,
    });
  }
  return out;
}

function _readState(projectRoot) {
  const p = path.join(projectStateDir(projectRoot), 'STATE.md');
  const raw = _safeReadFile(p);
  if (!raw) return { current_milestone: null, current_task: null };
  try {
    const { frontmatter } = extractFrontmatter(raw);
    return {
      current_milestone: frontmatter.current_milestone || null,
      current_task: frontmatter.current_task || null,
    };
  } catch {
    return { current_milestone: null, current_task: null };
  }
}

function collectSnapshot(projectRoot) {
  const cwd = projectRoot || process.cwd();
  const git = (() => { try { return workspaceGitInfo(cwd); } catch { return { is_repo: false }; } })();
  const state = _readState(cwd);
  const milestones = _collectMilestones(cwd);
  const worktrees = (() => { try { return listSliceWorktrees(cwd); } catch { return []; } })();
  const handoffs = (() => {
    try { return listHandoffs({}, cwd); } catch { return []; }
  })();
  const openHandoffs = handoffs.filter((h) => h.status === 'open');
  return {
    generated_at: new Date().toISOString(),
    project_root: cwd,
    git,
    state,
    milestones,
    worktrees,
    handoffs: {
      total: handoffs.length,
      open: openHandoffs.length,
      recent: handoffs.slice(-5).reverse(),
    },
    worktree_isolation: worktreeIsolationEnabled(cwd),
  };
}

function _pad(s, n) {
  const str = String(s);
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

function _sliceBar(statuses, useColor) {
  const parts = [];
  for (const s of statuses) {
    const g = STATUS_GLYPHS[s] || STATUS_GLYPHS.pending;
    parts.push(useColor ? g.color + g.glyph + ANSI.reset : g.glyph);
  }
  return parts.join(' ');
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

function renderSnapshot(snap, opts) {
  const o = opts || {};
  const useColor = o.color !== false;
  const lines = [];
  const c = (code, text) => useColor ? code + text + ANSI.reset : text;

  const title = 'nubos-pilot';
  const branch = (snap.git && snap.git.current_branch) ? snap.git.current_branch : '(no git)';
  lines.push(c(ANSI.bold + ANSI.blue, title) + '  ' + c(ANSI.dim, snap.project_root));
  lines.push(c(ANSI.dim, 'Branch: ' + branch + '   ·   Generated: ' + snap.generated_at));
  if (snap.worktree_isolation) {
    lines.push(c(ANSI.cyan, 'Worktree isolation: on') + c(ANSI.dim, '   (' + snap.worktrees.length + ' active)'));
  } else {
    lines.push(c(ANSI.dim, 'Worktree isolation: off'));
  }
  lines.push('');

  if (snap.milestones.length === 0) {
    lines.push(c(ANSI.dim, 'No milestones yet. Run /np:new-project or /np:new-milestone.'));
  } else {
    lines.push(c(ANSI.bold, 'Milestones'));
    for (const m of snap.milestones) {
      const name = m.name ? ' — ' + m.name : '';
      const status = m.status ? '  ' + c(ANSI.dim, '[' + m.status + ']') : '';
      const marker = (snap.state.current_milestone === m.id) ? c(ANSI.cyan, '▶ ') : '  ';
      lines.push(marker + c(ANSI.bold, m.id) + name + status);
      if (m.slices.length === 0) {
        lines.push('    ' + c(ANSI.dim, 'no slices planned'));
      }
      for (const s of m.slices) {
        lines.push('    ' + c(ANSI.bold, s.full_id) + '  ' + _summarizeCounts(s.counts, useColor));
        if (s.tasks_statuses.length > 0) {
          lines.push('    ' + _sliceBar(s.tasks_statuses, useColor));
        }
      }
      lines.push('');
    }
  }

  if (snap.worktrees.length > 0) {
    lines.push(c(ANSI.bold, 'Active worktrees'));
    for (const w of snap.worktrees) {
      lines.push('  ' + c(ANSI.cyan, w.slice_full_id) + '  ' + c(ANSI.dim, w.path));
    }
    lines.push('');
  }

  const totalH = snap.handoffs.total;
  const openH = snap.handoffs.open;
  lines.push(c(ANSI.bold, 'Handoffs') + c(ANSI.dim, '  (' + openH + ' open / ' + totalH + ' total)'));
  if (snap.handoffs.recent.length === 0) {
    lines.push('  ' + c(ANSI.dim, 'none'));
  } else {
    for (const h of snap.handoffs.recent) {
      const statusColor = h.status === 'open' ? ANSI.yellow
                        : h.status === 'acted' ? ANSI.green
                        : h.status === 'archived' ? ANSI.dim
                        : ANSI.reset;
      const status = c(statusColor, _pad(h.status, 9));
      const route = c(ANSI.cyan, _pad(h.from_agent + ' → ' + h.to_agent, 32));
      const ms = h.milestone ? c(ANSI.dim, ' [' + h.milestone + ']') : '';
      lines.push('  ' + status + ' ' + route + ' ' + h.topic + ms);
    }
  }
  lines.push('');

  lines.push(c(ANSI.dim, 'Refresh: re-run `np-tools.cjs dashboard` (or --watch <seconds>).'));
  return lines.join('\n');
}

module.exports = {
  collectSnapshot,
  renderSnapshot,
  ANSI,
  STATUS_GLYPHS,
};

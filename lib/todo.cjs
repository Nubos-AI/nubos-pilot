'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { atomicWriteFileSync, NubosPilotError } = require('./core.cjs');
const { parseSliceFullId, sliceDir, listTasks, mId } = require('./layout.cjs');

const STATUS_CHECKBOX = Object.freeze({
  'pending':      '[ ]',
  'in-progress':  '[~]',
  'done':         '[x]',
  'skipped':      '[-]',
  'parked':       '[!]',
});

function _checkbox(status) {
  return STATUS_CHECKBOX[status] || '[?]';
}

function _taskNameFromPlan(planPath) {
  let raw;
  try { raw = fs.readFileSync(planPath, 'utf-8'); } catch { return null; }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      const header = m[1].trim();
      const split = header.match(/^\S+\s+—\s+(.+)$/);
      return split ? split[1].trim() : header;
    }
  }
  return null;
}

function _nowIsoZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function _collectTasks(sliceFullId, cwd) {
  const { milestone, slice } = parseSliceFullId(sliceFullId);
  const entries = listTasks(milestone, slice, cwd);
  const result = [];
  for (const e of entries) {
    let raw;
    try { raw = fs.readFileSync(e.plan_path, 'utf-8'); } catch { continue; }
    let fm;
    try { ({ frontmatter: fm } = extractFrontmatter(raw)); }
    catch { fm = {}; }
    const status = typeof fm.status === 'string' ? fm.status : 'pending';
    result.push({
      id: e.full_id,
      short_id: e.id,
      status,
      name: _taskNameFromPlan(e.plan_path),
      plan_path: e.plan_path,
    });
  }
  return result;
}

function _buildContent(sliceFullId, tasks) {
  const counts = { total: 0, pending: 0, 'in-progress': 0, done: 0, skipped: 0, parked: 0 };
  for (const t of tasks) {
    counts.total += 1;
    if (Object.prototype.hasOwnProperty.call(counts, t.status)) {
      counts[t.status] += 1;
    }
  }
  const { milestone } = parseSliceFullId(sliceFullId);
  const fm = [
    '---',
    'schema_version: 1',
    'milestone_id: ' + mId(milestone),
    'slice_id: ' + sliceFullId,
    'total: ' + counts.total,
    'pending: ' + counts.pending,
    'in_progress: ' + counts['in-progress'],
    'done: ' + counts.done,
    'skipped: ' + counts.skipped,
    'parked: ' + counts.parked,
    'updated_at: ' + _nowIsoZ(),
    '---',
  ].join('\n');

  const heading = '# Slice ' + sliceFullId;
  let body;
  if (tasks.length === 0) {
    body = '_No tasks yet._';
  } else {
    const rows = tasks.map((t) => {
      const name = t.name || '(unnamed)';
      return '- ' + _checkbox(t.status) + ' **' + t.id + '** — ' + name;
    });
    body = rows.join('\n');
  }
  return fm + '\n\n' + heading + '\n\n' + body + '\n';
}

function todoPath(sliceFullId, cwd) {
  const { milestone, slice } = parseSliceFullId(sliceFullId);
  return path.join(sliceDir(milestone, slice, cwd || process.cwd()), 'TODO.md');
}

function renderTodoMd(sliceFullId, cwd) {
  if (!sliceFullId || typeof sliceFullId !== 'string') {
    throw new NubosPilotError(
      'todo-missing-slice-id',
      'renderTodoMd requires sliceFullId (e.g. M001-S001)',
      { got: sliceFullId },
    );
  }
  parseSliceFullId(sliceFullId);
  const workingDir = cwd || process.cwd();
  const tasks = _collectTasks(sliceFullId, workingDir);
  const content = _buildContent(sliceFullId, tasks);
  const target = todoPath(sliceFullId, workingDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFileSync(target, content);
  return target;
}

module.exports = {
  renderTodoMd,
  todoPath,
  STATUS_CHECKBOX,
};

'use strict';

const fs = require('node:fs');

const { extractFrontmatter } = require('./frontmatter.cjs');
const layout = require('./layout.cjs');
const { mutateMilestoneNode, parseRoadmap, _findPhaseTarget } = require('./roadmap.cjs');
const { SLICE_STATUSES, isDoneMilestoneStatus } = require('./roadmap-schema.cjs');
const { setMilestoneMetaStatus } = require('./milestone-meta.cjs');

const _TERMINAL_TASK_STATUSES = new Set(['done', 'skipped']);
const _STARTED_TASK_STATUSES = new Set(['in-progress', 'done', 'skipped', 'parked']);

const _LIFTABLE_MILESTONE_STATUSES = new Set(['pending', 'failed', 'deferred']);

const _SLICE_ID_RE = /^S(\d{3,})$/;

function _taskStatus(planPath) {
  try {
    const raw = fs.readFileSync(planPath, 'utf-8');
    const { frontmatter } = extractFrontmatter(raw);
    const s = frontmatter && frontmatter.status;
    return typeof s === 'string' ? s : undefined;
  } catch { return undefined; }
}

function deriveSliceStatus(taskStatuses) {
  if (taskStatuses.length === 0) return null;
  const unreadable = taskStatuses.filter((s) => s === undefined).length;
  const known = taskStatuses.filter((s) => typeof s === 'string');
  if (unreadable === 0 && known.every((s) => _TERMINAL_TASK_STATUSES.has(s))) return 'done';
  if (known.some((s) => _STARTED_TASK_STATUSES.has(s))) return 'in-progress';
  return 'pending';
}

function _sliceTaskStatuses(mNum, sNum, cwd) {
  return layout.listTasks(mNum, sNum, cwd).map((t) => _taskStatus(t.plan_path));
}

function _derive(mNum, declaredSlices, cwd) {
  const slices = [];
  const invalidIds = [];
  let unreadable = 0;
  for (const decl of declaredSlices) {
    const id = decl && typeof decl.id === 'string' ? decl.id : null;
    if (!id) continue;
    const m = id.match(_SLICE_ID_RE);
    if (!m) {
      invalidIds.push(id);
      slices.push({ id, persisted: typeof decl.status === 'string' ? decl.status : null, derived: null, task_count: 0, all_parked: false });
      continue;
    }
    const sNum = Number(m[1]);
    const statuses = _sliceTaskStatuses(mNum, sNum, cwd);
    unreadable += statuses.filter((s) => s === undefined).length;
    slices.push({
      id,
      persisted: typeof decl.status === 'string' ? decl.status : null,
      derived: deriveSliceStatus(statuses),
      task_count: statuses.length,
      all_parked: statuses.length > 0 && statuses.every((s) => s === 'parked'),
    });
  }
  const derivedList = slices.map((s) => s.derived);
  return {
    slices,
    unreadable_tasks: unreadable,
    invalid_slice_ids: invalidIds,
    fully_parked: slices.filter((s) => s.all_parked).map((s) => s.id),
    all_done: derivedList.length > 0 && derivedList.every((s) => s === 'done'),
    any_started: derivedList.some((s) => s === 'in-progress' || s === 'done'),
  };
}

function _rawMilestoneNode(mNum, cwd) {
  let doc;
  try { doc = parseRoadmap(cwd).doc; } catch { return null; }
  if (!doc || !Array.isArray(doc.milestones)) return null;
  try { return _findPhaseTarget(doc, String(mNum)); } catch { return null; }
}

function inspectMilestone(mNum, cwd) {
  const node = _rawMilestoneNode(mNum, cwd);
  const declared = node && Array.isArray(node.slices) ? node.slices : [];
  const out = _derive(mNum, declared, cwd);
  return Object.assign({
    milestone_status: node && typeof node.status === 'string' ? node.status : null,
  }, out);
}

function _nextMilestoneStatus(current, derived) {
  const cur = typeof current === 'string' ? current : 'pending';
  if (derived.any_started && _LIFTABLE_MILESTONE_STATUSES.has(cur)) return 'in-progress';
  const regressed = derived.slices.some((s) => s.derived !== null && s.derived !== 'done');
  if (isDoneMilestoneStatus(cur) && regressed) return 'in-progress';
  return null;
}

function rollupMilestone(mNum, cwd) {
  let outcome;
  try {
    outcome = mutateMilestoneNode(mNum, (ms) => {
      const declared = Array.isArray(ms.slices) ? ms.slices : [];
      const derived = _derive(mNum, declared, cwd);
      const slicesChanged = [];

      for (const s of derived.slices) {
        if (s.derived === null || !SLICE_STATUSES.includes(s.derived)) continue;
        const node = declared.find((d) => d && String(d.id) === s.id);
        if (!node) continue;
        const previous = typeof node.status === 'string' ? node.status : null;
        if (previous === s.derived) continue;
        node.status = s.derived;
        slicesChanged.push({ slice: s.id, from: previous, to: s.derived });
      }

      let milestoneChange = null;
      const next = _nextMilestoneStatus(ms.status, derived);
      if (next && ms.status !== next) {
        milestoneChange = { from: typeof ms.status === 'string' ? ms.status : null, to: next };
        ms.status = next;
      }

      return {
        milestone: layout.mId(mNum),
        milestone_status: milestoneChange,
        milestone_status_now: ms.status,
        slices_changed: slicesChanged,
        all_slices_done: derived.all_done,
        unreadable_tasks: derived.unreadable_tasks,
        changed: slicesChanged.length > 0 || milestoneChange !== null,
      };
    }, cwd, {
      skipWrite: (r) => r && r.changed === false,
      lock: { timeoutMs: 2000 },
    });
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      return {
        milestone: layout.mId(mNum),
        milestone_status: null,
        slices_changed: [],
        all_slices_done: false,
        unreadable_tasks: 0,
        changed: false,
        reason: 'phase-not-found',
      };
    }
    throw err;
  }
  if (outcome && outcome.milestone_status) {
    try {
      setMilestoneMetaStatus(mNum, outcome.milestone_status.to, cwd);
    } catch (err) {
      outcome.meta_sync_error = (err && err.code) || 'meta-sync-error';
    }
  }
  return outcome;
}

function markMilestoneStarted(mNum, cwd) {
  return mutateMilestoneNode(mNum, (ms) => {
    const cur = typeof ms.status === 'string' ? ms.status : 'pending';
    if (!_LIFTABLE_MILESTONE_STATUSES.has(cur) || cur === 'in-progress') {
      return { changed: false, status: cur };
    }
    ms.status = 'in-progress';
    return { changed: true, from: cur, to: 'in-progress', status: 'in-progress' };
  }, cwd, { skipWrite: (r) => r && r.changed === false });
}

function rollupFromTask(taskFullId, cwd) {
  const { milestone } = layout.parseTaskFullId(taskFullId);
  return rollupMilestone(milestone, cwd);
}

module.exports = {
  deriveSliceStatus,
  inspectMilestone,
  markMilestoneStarted,
  rollupMilestone,
  rollupFromTask,
};

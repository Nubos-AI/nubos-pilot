'use strict';

// Shared read of the planning hierarchy off disk.
//
// Two consumers need the same tree for different reasons — lib/otlp.cjs turns it
// into spans (ADR-0026) and lib/roadmap-graph.cjs turns it into a diagram
// (ADR-0027) — and both need it assembled from the same two sources, because
// neither source alone is authoritative:
//
//   * roadmap.yaml owns milestone/slice identity, declared status and depends_on.
//   * the task plans on disk own task status and task-level depends_on, which is
//     what `rollup` already treats as the truth (roadmap slice status is derived
//     FROM them, so reading roadmap for task state would be reading a cache).
//
// Extracted rather than copied: a second hand-rolled walk would drift from this
// one the first time the layout changes, and the two views would then disagree
// about the same project.

const fs = require('node:fs');

const layout = require('./layout.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { parseRoadmap } = require('./roadmap.cjs');

/**
 * Read a task plan's frontmatter, tolerating an absent or malformed file.
 * A task directory with no readable plan still exists as a unit, so it is
 * reported with a null status rather than skipped — an unreadable task is a
 * finding for `doctor`, not something a view should hide.
 */
function _taskFrontmatter(planPath) {
  try {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(planPath, 'utf-8'));
    return frontmatter || {};
  } catch {
    return {};
  }
}

function _str(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Collect the milestone → slice → task tree.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {number|null} [opts.milestone] restrict to one milestone number
 * @returns {object[]} [{id, name, status, depends_on, slices: [{id, name, status, tasks: [{id, name, status, depends_on}]}]}]
 */
function collectTree(cwd, opts) {
  const o = opts || {};
  const only = Number.isInteger(o.milestone) ? o.milestone : null;

  let doc;
  try {
    doc = parseRoadmap(cwd).doc;
  } catch {
    // No roadmap, an unparseable one, or not inside a project: an empty tree is
    // the honest answer for a view, and the parse error itself is already
    // reported by every workflow that needs the roadmap to proceed.
    return [];
  }
  const declared = doc && Array.isArray(doc.milestones) ? doc.milestones : [];
  const out = [];

  for (const msNode of declared) {
    const id = _str(msNode && msNode.id);
    if (!id) continue;
    let mNum;
    try {
      mNum = layout.parseMId(id);
    } catch {
      continue;
    }
    if (only !== null && mNum !== only) continue;

    const slices = [];
    for (const slNode of (Array.isArray(msNode.slices) ? msNode.slices : [])) {
      const sid = _str(slNode && slNode.id);
      if (!sid) continue;
      let sNum;
      try {
        sNum = layout.parseSId(sid);
      } catch {
        continue;
      }
      const tasks = layout.listTasks(mNum, sNum, cwd).map((t) => {
        const fm = _taskFrontmatter(t.plan_path);
        return {
          id: t.full_id,
          // The local id (T0001) is what a task's own depends_on references, so
          // both spellings travel with the node.
          local_id: t.id,
          name: _str(fm.title) || _str(fm.name),
          status: _str(fm.status),
          depends_on: fm.depends_on == null ? null : fm.depends_on,
        };
      });
      slices.push({
        id: layout.sliceFullId(mNum, sNum),
        local_id: sid,
        name: _str(slNode.name),
        status: _str(slNode.status),
        when: slNode.when,
        tasks,
      });
    }

    out.push({
      id,
      number: mNum,
      name: _str(msNode.name),
      status: _str(msNode.status),
      depends_on: msNode.depends_on == null ? null : msNode.depends_on,
      slices,
    });
  }
  return out;
}

module.exports = { collectTree, _taskFrontmatter };

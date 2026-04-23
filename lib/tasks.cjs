const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { NubosPilotError, withFileLock, atomicWriteFileSync } = require('./core.cjs');

const TASK_REQUIRED_FIELDS = [
  'id',
  'slice',
  'milestone',
  'type',
  'status',
  'tier',
  'owner',
  'wave',
  'depends_on',
  'files_modified',
  'autonomous',
  'must_haves',
];

const TASK_STATUS_ENUM = new Set(['pending', 'in-progress', 'done', 'skipped', 'parked']);
const TASK_TIER_ENUM = new Set(['haiku', 'sonnet', 'opus']);
const TASK_ID_RE = /^M\d{3,}-S\d{3,}-T\d{4,}$/;

function _isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTaskFrontmatter(fm, taskId) {
  if (!_isPlainObject(fm)) {
    throw new NubosPilotError(
      'tasks-invalid-frontmatter',
      `Task ${taskId} frontmatter must be an object`,
      { task: taskId, missing: TASK_REQUIRED_FIELDS.slice(), wrong_type: [] },
    );
  }
  const missing = [];
  const wrongType = [];
  for (const field of TASK_REQUIRED_FIELDS) {
    if (!(field in fm)) {
      missing.push(field);
    }
  }
  if ('depends_on' in fm && !Array.isArray(fm.depends_on)) wrongType.push('depends_on');
  if ('files_modified' in fm && !Array.isArray(fm.files_modified)) wrongType.push('files_modified');
  if ('autonomous' in fm && typeof fm.autonomous !== 'boolean') wrongType.push('autonomous');
  if ('wave' in fm && fm.wave !== null && typeof fm.wave !== 'number') wrongType.push('wave');
  if ('must_haves' in fm && !_isPlainObject(fm.must_haves)) wrongType.push('must_haves');

  if (missing.length > 0 || wrongType.length > 0) {
    throw new NubosPilotError(
      'tasks-invalid-frontmatter',
      `Task ${taskId} frontmatter invalid (missing: [${missing.join(', ')}], wrong_type: [${wrongType.join(', ')}])`,
      { task: taskId, missing, wrong_type: wrongType },
    );
  }

  if ('id' in fm && !TASK_ID_RE.test(String(fm.id))) {
    throw new NubosPilotError(
      'tasks-invalid-frontmatter',
      `Task ${taskId} has invalid id format '${fm.id}' (expected M<NNN>-S<NNN>-T<NNNN>, e.g. M001-S001-T0001)`,
      { task: taskId, field: 'id', got: fm.id, expected: 'M<NNN>-S<NNN>-T<NNNN>' },
    );
  }
  if ('status' in fm && !TASK_STATUS_ENUM.has(fm.status)) {
    throw new NubosPilotError(
      'tasks-invalid-status',
      `Task ${taskId} has invalid status '${fm.status}'`,
      { task: taskId, got: fm.status, allowed: [...TASK_STATUS_ENUM] },
    );
  }
  if ('tier' in fm && !TASK_TIER_ENUM.has(fm.tier)) {
    throw new NubosPilotError(
      'tasks-invalid-tier',
      `Task ${taskId} has invalid tier '${fm.tier}'`,
      { task: taskId, got: fm.tier, allowed: [...TASK_TIER_ENUM] },
    );
  }
  if ('owner' in fm && (typeof fm.owner !== 'string' || fm.owner.length === 0)) {
    throw new NubosPilotError(
      'tasks-invalid-owner',
      `Task ${taskId} has invalid owner (must be non-empty string)`,
      { task: taskId, got: fm.owner },
    );
  }
}

function _extractCycle(remaining, children) {
  const remainingSet = remaining instanceof Set ? remaining : new Set(remaining);
  if (remainingSet.size === 0) return [];
  const start = [...remainingSet].sort()[0];
  const path = [];
  const onPath = new Set();

  function visit(node) {
    path.push(node);
    onPath.add(node);
    const kids = children.get(node) || [];
    const sortedKids = [...kids].sort();
    for (const k of sortedKids) {
      if (!remainingSet.has(k)) continue;
      if (onPath.has(k)) {
        const idx = path.indexOf(k);
        return path.slice(idx).concat(k);
      }
      const result = visit(k);
      if (result) return result;
    }
    path.pop();
    onPath.delete(node);
    return null;
  }

  const result = visit(start);
  if (result) return result;
  return path.length > 0 ? path.slice() : [start];
}

function computeWaves(tasks) {
  const idSet = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    const deps = t.depends_on || [];
    for (const dep of deps) {
      if (!idSet.has(dep)) {
        throw new NubosPilotError(
          'tasks-unknown-dep',
          `Task ${t.id} depends on unknown task ${dep}`,
          { task: t.id, missing_dep: dep },
        );
      }
    }
  }

  const indeg = new Map();
  const children = new Map();
  for (const t of tasks) {
    indeg.set(t.id, (t.depends_on || []).length);
    children.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      children.get(dep).push(t.id);
    }
  }

  const remaining = new Set(tasks.map((t) => t.id));
  const wavesById = new Map();
  const waves = [];
  let waveNum = 1;

  while (remaining.size > 0) {
    const layer = [...remaining].filter((id) => indeg.get(id) === 0).sort();
    if (layer.length === 0) {
      const cycle = _extractCycle(remaining, children);
      throw new NubosPilotError(
        'tasks-cyclic',
        `Cycle detected in task graph: ${cycle.join(' -> ')}`,
        { cycle },
      );
    }
    for (const id of layer) {
      wavesById.set(id, waveNum);
      for (const child of children.get(id) || []) {
        indeg.set(child, indeg.get(child) - 1);
      }
      remaining.delete(id);
    }
    waves.push(layer);
    waveNum += 1;
  }

  const warnings = [];
  for (const t of tasks) {
    if (t.wave != null && typeof t.wave === 'number') {
      const computed = wavesById.get(t.id);
      if (t.wave !== computed) {
        warnings.push({
          code: 'wave-override-conflict',
          task: t.id,
          user_wave: t.wave,
          computed_wave: computed,
        });
      }
    }
  }

  return { waves, wavesById, warnings };
}

function loadTaskGraph(sliceDir) {
  const tasksDir = path.join(sliceDir, 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        tasks: [],
        graph: new Map(),
        waves: [],
        wavesById: new Map(),
        warnings: [],
        errors: [],
      };
    }
    throw err;
  }

  const taskDirs = entries
    .filter((e) => e.isDirectory() && /^T\d{4,}$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const taskRecords = [];
  for (const name of taskDirs) {
    const absPath = path.join(tasksDir, name, name + '-PLAN.md');
    let raw;
    try { raw = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }
    const { frontmatter } = extractFrontmatter(raw);
    const id = typeof frontmatter.id === 'string' ? frontmatter.id : name;
    validateTaskFrontmatter(frontmatter, id);
    taskRecords.push({ id, frontmatter, path: absPath });
  }

  const computeInput = taskRecords.map((r) => ({
    id: r.id,
    depends_on: r.frontmatter.depends_on || [],
    wave: r.frontmatter.wave,
  }));

  const { waves, wavesById, warnings } = computeWaves(computeInput);

  const graph = new Map();
  for (const r of taskRecords) graph.set(r.id, []);
  for (const r of taskRecords) {
    for (const dep of r.frontmatter.depends_on || []) {
      graph.get(dep).push(r.id);
    }
  }

  return {
    tasks: taskRecords,
    graph,
    waves,
    wavesById,
    warnings,
    errors: [],
  };
}

function _findTaskFile(taskId, cwd) {
  const { parseTaskFullId, taskPlanPath } = require('./layout.cjs');
  let parsed;
  try { parsed = parseTaskFullId(taskId); } catch { return null; }
  const candidate = taskPlanPath(parsed.milestone, parsed.slice, parsed.task, cwd);
  try {
    fs.accessSync(candidate, fs.constants.F_OK);
    return candidate;
  } catch {
    return null;
  }
}

function _rewriteStatusLine(raw, newStatus) {
  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!fmMatch) {
    throw new NubosPilotError(
      'task-frontmatter-missing',
      'Task file has no YAML frontmatter block',
      {},
    );
  }
  const [, openFence, fmBody, closeFence] = fmMatch;

  const statusRe = /^status:\s*.*$/m;
  if (!statusRe.test(fmBody)) {
    throw new NubosPilotError(
      'task-status-line-missing',
      'Frontmatter does not contain a top-level status: field',
      {},
    );
  }
  const newFmBody = fmBody.replace(statusRe, `status: ${newStatus}`);
  const rest = raw.slice(fmMatch[0].length);
  return openFence + newFmBody + closeFence + rest;
}

function setTaskStatus(taskId, newStatus, cwd = process.cwd()) {
  if (!TASK_STATUS_ENUM.has(newStatus)) {
    throw new NubosPilotError(
      'invalid-task-status',
      `Status '${newStatus}' not in enum [${[...TASK_STATUS_ENUM].join(', ')}]`,
      { taskId, newStatus, allowed: [...TASK_STATUS_ENUM] },
    );
  }
  const filePath = _findTaskFile(taskId, cwd);
  if (!filePath) {
    throw new NubosPilotError(
      'task-not-found',
      `No task file for id ${taskId}`,
      { taskId, cwd },
    );
  }
  return withFileLock(filePath, () => {
    const raw = fs.readFileSync(filePath, 'utf-8');

    const { frontmatter } = extractFrontmatter(raw);
    if (!('status' in frontmatter)) {
      throw new NubosPilotError(
        'task-status-line-missing',
        `Task ${taskId} frontmatter has no status field`,
        { taskId },
      );
    }
    const next = _rewriteStatusLine(raw, newStatus);
    atomicWriteFileSync(filePath, next);

    const sliceFullId = typeof frontmatter.slice === 'string' ? frontmatter.slice : null;
    if (sliceFullId) {
      try {
        const { renderTodoMd } = require('./todo.cjs');
        renderTodoMd(sliceFullId, cwd);
      } catch (err) {
        process.stderr.write(
          '[nubos-pilot warn] TODO.md render failed for ' + sliceFullId + ': ' + ((err && err.message) || err) + '\n',
        );
      }
    }

    return newStatus;
  });
}

module.exports = {
  loadTaskGraph,
  validateTaskFrontmatter,
  computeWaves,
  setTaskStatus,
  TASK_REQUIRED_FIELDS,
  TASK_STATUS_ENUM,
  TASK_TIER_ENUM,
  TASK_ID_RE,
};

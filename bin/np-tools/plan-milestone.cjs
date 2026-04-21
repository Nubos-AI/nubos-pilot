'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  NubosPilotError,
  projectStateDir,
  atomicWriteFileSync,
  withFileLock,
} = require('../../lib/core.cjs');
const layout = require('../../lib/layout.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');
const textMode = require('../../lib/text-mode.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _validateMilestoneArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'plan-milestone-invalid-arg',
      'plan-milestone requires a milestone number (integer)',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+$/.test(s)) {
    throw new NubosPilotError(
      'plan-milestone-invalid-arg',
      'Invalid milestone number (must be positive integer): ' + s,
      { value: s },
    );
  }
  return Number(s);
}

function _safeSkills(name, cwd) {
  try { return getAgentSkills(name, cwd); } catch { return []; }
}

function _emit(payload, stdout, cwd) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= INLINE_THRESHOLD_BYTES) {
    stdout.write(json);
    return;
  }
  let tmpDir;
  try {
    tmpDir = path.join(projectStateDir(cwd), '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch { tmpDir = os.tmpdir(); }
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-plan-milestone-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _readMilestoneDef(mNum, cwd) {
  let def;
  try {
    def = getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'plan-milestone-not-found',
        'Milestone ' + mNum + ' not found in roadmap.yaml',
        { number: mNum },
      );
    }
    throw err;
  }
  return def;
}

function _initPayload(mNum, cwd) {
  const def = _readMilestoneDef(mNum, cwd);
  const mDirAbs = layout.milestoneDir(mNum, cwd);
  const contextPath = layout.milestoneContextPath(mNum, cwd);
  const roadmapPath = layout.milestoneRoadmapPath(mNum, cwd);
  const metaPath = layout.milestoneMetaPath(mNum, cwd);

  const existingSlices = layout.listSlices(mNum, cwd);
  const sliceStatus = existingSlices.map((s) => {
    const planPath = layout.slicePlanPath(mNum, s.number, cwd);
    const assessmentPath = layout.sliceAssessmentPath(mNum, s.number, cwd);
    const researchPath = layout.sliceResearchPath(mNum, s.number, cwd);
    const summaryPath = layout.sliceSummaryPath(mNum, s.number, cwd);
    const uatPath = layout.sliceUatPath(mNum, s.number, cwd);
    const tasks = layout.listTasks(mNum, s.number, cwd);
    return {
      id: s.id,
      full_id: s.full_id,
      number: s.number,
      slice_dir: s.path,
      plan_path: planPath,
      has_plan: fs.existsSync(planPath),
      has_assessment: fs.existsSync(assessmentPath),
      has_research: fs.existsSync(researchPath),
      has_summary: fs.existsSync(summaryPath),
      has_uat: fs.existsSync(uatPath),
      task_count: tasks.length,
    };
  });

  const tmDetail = textMode.resolveTextModeDetail(cwd);

  return {
    _workflow: 'plan-milestone',
    milestone: mNum,
    milestone_id: layout.mId(mNum),
    milestone_dir: mDirAbs,
    milestone_context_path: contextPath,
    milestone_roadmap_path: roadmapPath,
    milestone_meta_path: metaPath,
    name: def.name || '',
    goal: def.goal || '',
    requirements: Array.isArray(def.requirements) ? def.requirements : [],
    success_criteria: Array.isArray(def.success_criteria) ? def.success_criteria : [],
    has_context: fs.existsSync(contextPath),
    has_roadmap: fs.existsSync(roadmapPath),
    has_meta: fs.existsSync(metaPath),
    existing_slices: sliceStatus,
    planner_tier: 'opus',
    checker_tier: 'opus',
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: {
      'np-planner': _safeSkills('np-planner', cwd),
      'np-plan-checker': _safeSkills('np-plan-checker', cwd),
    },
  };
}

function _extractTasksFromSlicePlan(planPath) {
  const raw = fs.readFileSync(planPath, 'utf-8');
  const tagRe = /<task\s+([^>]+?)(\/>|>([\s\S]*?)<\/task>)/g;
  const attrRe = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = tagRe.exec(raw)) !== null) {
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const depsRaw = attrs.depends_on || '';
    const deps = depsRaw
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      id: attrs.id || '',
      body: m[3] || '',
      attrs: {
        tier: attrs.tier || '',
        wave: attrs.wave ? Number(attrs.wave) : null,
        depends_on: deps,
      },
    });
  }
  return out;
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _buildMilestoneRemap(mNum, cwd) {
  const slices = layout.listSlices(mNum, cwd);
  const remap = new Map();
  for (const s of slices) {
    const planPath = layout.slicePlanPath(mNum, s.number, cwd);
    if (!fs.existsSync(planPath)) continue;
    const tasks = _extractTasksFromSlicePlan(planPath);
    tasks.forEach((t, idx) => {
      const oldId = t.id;
      if (!oldId) return;
      const newId = layout.taskFullId(mNum, s.number, idx + 1);
      if (oldId !== newId) remap.set(oldId, newId);
    });
  }
  return remap;
}

function _rewriteSlicePlanIds(planPath, remap) {
  if (remap.size === 0) return false;
  const raw = fs.readFileSync(planPath, 'utf-8');
  const keys = [...remap.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp('\\b(' + keys.map(_escapeRegex).join('|') + ')\\b', 'g');
  const next = raw.replace(re, (m) => remap.get(m) || m);
  if (next === raw) return false;
  atomicWriteFileSync(planPath, next);
  return true;
}

function _normalizeMilestoneTaskIds(mNum, cwd) {
  const remap = _buildMilestoneRemap(mNum, cwd);
  if (remap.size === 0) return { changed: false, remap: {} };
  const slices = layout.listSlices(mNum, cwd);
  for (const s of slices) {
    const planPath = layout.slicePlanPath(mNum, s.number, cwd);
    if (!fs.existsSync(planPath)) continue;
    _rewriteSlicePlanIds(planPath, remap);
  }
  return { changed: true, remap: Object.fromEntries(remap) };
}

function _extractInnerTag(body, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

function _parseFilesList(body) {
  const raw = _extractInnerTag(body, 'files_modified') || _extractInnerTag(body, 'files');
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function _filesYaml(files) {
  if (!files.length) return '[]';
  return '\n' + files.map((f) => '  - ' + JSON.stringify(f)).join('\n');
}

function _depsYaml(deps) {
  if (!deps.length) return '[]';
  return '\n' + deps.map((d) => '  - ' + JSON.stringify(d)).join('\n');
}

function _renderTaskPlanMd(task, mNum, sNum) {
  const fullId = task.id || layout.taskFullId(mNum, sNum, 0);
  const parsed = fullId.match(/T(\d{4,})$/);
  const taskNum = parsed ? Number(parsed[1]) : 0;
  const name = _extractInnerTag(task.body, 'name') || fullId;
  const filesList = _parseFilesList(task.body);
  const readFirst = _extractInnerTag(task.body, 'read_first');
  const action = _extractInnerTag(task.body, 'action');
  const verify = _extractInnerTag(task.body, 'verify');
  const accept = _extractInnerTag(task.body, 'acceptance_criteria');
  const done = _extractInnerTag(task.body, 'done');

  const lines = [
    '---',
    'id: ' + JSON.stringify(fullId),
    'slice: ' + JSON.stringify(layout.sliceFullId(mNum, sNum)),
    'milestone: ' + JSON.stringify(layout.mId(mNum)),
    'type: execute',
    'status: pending',
    'tier: ' + JSON.stringify(task.attrs.tier || 'sonnet'),
    'owner: executor',
    'wave: ' + (task.attrs.wave == null ? Number(sNum) : Number(task.attrs.wave)),
    'depends_on: ' + _depsYaml(task.attrs.depends_on),
    'files_modified: ' + _filesYaml(filesList),
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    '# ' + fullId + ' — ' + name,
    '',
  ];
  if (readFirst) lines.push('<read_first>', readFirst, '</read_first>', '');
  if (action)    lines.push('<action>', action, '</action>', '');
  if (verify)    lines.push('<verify>', verify, '</verify>', '');
  if (accept)    lines.push('<acceptance_criteria>', accept, '</acceptance_criteria>', '');
  if (done)      lines.push('<done>', done, '</done>', '');
  lines.push('<output>',
    'After completion, fill `' + layout.tId(taskNum) + '-SUMMARY.md` with:',
    '- What changed (one line per file touched)',
    '- Tests run + results',
    '- Follow-ups or deviations',
    '</output>',
    '');
  return lines.join('\n');
}

function _renderTaskSummaryMd(task, mNum, sNum) {
  const fullId = task.id;
  return [
    '---',
    'id: ' + JSON.stringify(fullId),
    'slice: ' + JSON.stringify(layout.sliceFullId(mNum, sNum)),
    'milestone: ' + JSON.stringify(layout.mId(mNum)),
    'type: summary',
    'status: pending',
    '---',
    '',
    '# ' + fullId + ' — SUMMARY',
    '',
    '_Executor fills this file after completing the task._',
    '',
    '## Changes',
    '- TBD',
    '',
    '## Verification',
    '- TBD',
    '',
    '## Follow-ups',
    '- None',
    '',
  ].join('\n');
}

function _scaffoldSliceTasks(mNum, sNum, cwd) {
  const planPath = layout.slicePlanPath(mNum, sNum, cwd);
  if (!fs.existsSync(planPath)) {
    return { scaffolded: [], reason: 'no-slice-plan', slice: layout.sliceFullId(mNum, sNum) };
  }
  const sliceRemap = new Map();
  const preTasks = _extractTasksFromSlicePlan(planPath);
  preTasks.forEach((t, idx) => {
    const newId = layout.taskFullId(mNum, sNum, idx + 1);
    if (t.id && t.id !== newId) sliceRemap.set(t.id, newId);
  });
  _rewriteSlicePlanIds(planPath, sliceRemap);
  const tasks = _extractTasksFromSlicePlan(planPath);
  if (tasks.length === 0) {
    return { scaffolded: [], reason: 'no-tasks-in-slice-plan', slice: layout.sliceFullId(mNum, sNum) };
  }
  const out = [];
  for (const t of tasks) {
    if (!t.id) continue;
    const parsed = t.id.match(/T(\d{4,})$/);
    if (!parsed) continue;
    const tNum = Number(parsed[1]);
    layout.createTaskDir(mNum, sNum, tNum, cwd);
    const planFilePath = layout.taskPlanPath(mNum, sNum, tNum, cwd);
    const summaryFilePath = layout.taskSummaryPath(mNum, sNum, tNum, cwd);
    if (!fs.existsSync(planFilePath)) {
      atomicWriteFileSync(planFilePath, _renderTaskPlanMd(t, mNum, sNum));
      out.push({ id: t.id, file: planFilePath, kind: 'plan', created: true });
    } else {
      out.push({ id: t.id, file: planFilePath, kind: 'plan', created: false });
    }
    if (!fs.existsSync(summaryFilePath)) {
      atomicWriteFileSync(summaryFilePath, _renderTaskSummaryMd(t, mNum, sNum));
      out.push({ id: t.id, file: summaryFilePath, kind: 'summary', created: true });
    } else {
      out.push({ id: t.id, file: summaryFilePath, kind: 'summary', created: false });
    }
  }
  return { scaffolded: out, reason: 'ok', slice: layout.sliceFullId(mNum, sNum), task_count: tasks.length };
}

function _scaffoldAllTasks(mNum, cwd) {
  _readMilestoneDef(mNum, cwd);
  const slices = layout.listSlices(mNum, cwd);
  if (slices.length === 0) {
    return { scaffolded: [], reason: 'no-slices', milestone: layout.mId(mNum) };
  }
  const normalized = _normalizeMilestoneTaskIds(mNum, cwd);
  const per = [];
  for (const s of slices) {
    per.push(_scaffoldSliceTasks(mNum, s.number, cwd));
  }
  const total = per.reduce((acc, p) => acc + (p.task_count || 0), 0);
  return {
    scaffolded: per,
    reason: 'ok',
    milestone: layout.mId(mNum),
    total_tasks: total,
    normalized_ids: normalized.changed ? normalized.remap : {},
  };
}

function _createMilestoneDir(mNum, cwd) {
  const dir = layout.createMilestoneDir(mNum, cwd);
  return { created: true, milestone: layout.mId(mNum), milestone_dir: dir };
}

function _createSliceDir(mNum, sNum, cwd) {
  layout.createMilestoneDir(mNum, cwd);
  const dir = layout.createSliceDir(mNum, sNum, cwd);
  return { created: true, slice: layout.sliceFullId(mNum, sNum), slice_dir: dir };
}

function _planMilestoneAbort(mNum, cwd) {
  const mDir = layout.findMilestoneDir(mNum, cwd);
  if (!mDir) return { aborted: true, removed: [], preserved: null };
  const slicesDir = path.join(mDir, 'slices');
  const removed = [];
  if (fs.existsSync(slicesDir)) {
    const entries = fs.readdirSync(slicesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sPath = path.join(slicesDir, e.name);
      try { fs.rmSync(sPath, { recursive: true, force: true }); removed.push(sPath); } catch {}
    }
  }
  return { aborted: true, removed, preserved: mDir };
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init': {
      const mNum = _validateMilestoneArg(list[1]);
      const payload = _initPayload(mNum, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    case 'create-milestone-dir': {
      const mNum = _validateMilestoneArg(list[1]);
      const result = _createMilestoneDir(mNum, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'create-slice-dir': {
      const mNum = _validateMilestoneArg(list[1]);
      const sNum = _validateMilestoneArg(list[2]);
      const result = _createSliceDir(mNum, sNum, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'scaffold-slice-tasks': {
      const mNum = _validateMilestoneArg(list[1]);
      const sNum = _validateMilestoneArg(list[2]);
      const result = _scaffoldSliceTasks(mNum, sNum, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'scaffold-all-tasks': {
      const mNum = _validateMilestoneArg(list[1]);
      const result = _scaffoldAllTasks(mNum, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    case 'abort': {
      const mNum = _validateMilestoneArg(list[1]);
      const result = _planMilestoneAbort(mNum, cwd);
      _emit(result, stdout, cwd);
      return result;
    }
    default:
      throw new NubosPilotError(
        'plan-milestone-unknown-verb',
        'plan-milestone: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };

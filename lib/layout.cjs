'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { projectStateDir, NubosPilotError, withFileLock } = require('./core.cjs');

const M_WIDTH = 3;
const S_WIDTH = 3;
const T_WIDTH = 4;

const M_RE = /^M(\d{3,})$/;
const S_RE = /^S(\d{3,})$/;
const T_RE = /^T(\d{4,})$/;
const SLICE_FULL_RE = /^M(\d{3,})-S(\d{3,})$/;
const TASK_FULL_RE = /^M(\d{3,})-S(\d{3,})-T(\d{4,})$/;

function _pad(n, width) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 0) {
    throw new NubosPilotError('layout-invalid-number', 'id number must be non-negative integer', { got: n });
  }
  return String(num).padStart(width, '0');
}

function mId(n) { return 'M' + _pad(n, M_WIDTH); }
function sId(n) { return 'S' + _pad(n, S_WIDTH); }
function tId(n) { return 'T' + _pad(n, T_WIDTH); }

function sliceFullId(mNum, sNum) { return mId(mNum) + '-' + sId(sNum); }
function taskFullId(mNum, sNum, tNum) { return mId(mNum) + '-' + sId(sNum) + '-' + tId(tNum); }

function parseMId(id) {
  const m = String(id || '').match(M_RE);
  if (!m) throw new NubosPilotError('layout-invalid-id', 'invalid milestone id: ' + id, { got: id });
  return Number(m[1]);
}

function parseSId(id) {
  const m = String(id || '').match(S_RE);
  if (!m) throw new NubosPilotError('layout-invalid-id', 'invalid slice id: ' + id, { got: id });
  return Number(m[1]);
}

function parseTId(id) {
  const m = String(id || '').match(T_RE);
  if (!m) throw new NubosPilotError('layout-invalid-id', 'invalid task id: ' + id, { got: id });
  return Number(m[1]);
}

function parseSliceFullId(id) {
  const m = String(id || '').match(SLICE_FULL_RE);
  if (!m) throw new NubosPilotError('layout-invalid-id', 'invalid slice full-id (expected M<NNN>-S<NNN>): ' + id, { got: id });
  return { milestone: Number(m[1]), slice: Number(m[2]) };
}

function parseTaskFullId(id) {
  const m = String(id || '').match(TASK_FULL_RE);
  if (!m) throw new NubosPilotError('layout-invalid-id', 'invalid task full-id (expected M<NNN>-S<NNN>-T<NNNN>): ' + id, { got: id });
  return { milestone: Number(m[1]), slice: Number(m[2]), task: Number(m[3]) };
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function milestonesRoot(cwd) {
  return path.join(projectStateDir(cwd || process.cwd()), 'milestones');
}

function milestoneDir(mNum, cwd) {
  return path.join(milestonesRoot(cwd), mId(mNum));
}

function milestoneContextPath(mNum, cwd) {
  return path.join(milestoneDir(mNum, cwd), mId(mNum) + '-CONTEXT.md');
}

function milestoneRoadmapPath(mNum, cwd) {
  return path.join(milestoneDir(mNum, cwd), mId(mNum) + '-ROADMAP.md');
}

function milestoneMetaPath(mNum, cwd) {
  return path.join(milestoneDir(mNum, cwd), mId(mNum) + '-META.json');
}

function slicesRoot(mNum, cwd) {
  return path.join(milestoneDir(mNum, cwd), 'slices');
}

function sliceDir(mNum, sNum, cwd) {
  return path.join(slicesRoot(mNum, cwd), sId(sNum));
}

function _slicePath(mNum, sNum, suffix, cwd) {
  return path.join(sliceDir(mNum, sNum, cwd), sId(sNum) + suffix);
}

function sliceAssessmentPath(mNum, sNum, cwd) { return _slicePath(mNum, sNum, '-ASSESSMENT.md', cwd); }
function slicePlanPath(mNum, sNum, cwd)       { return _slicePath(mNum, sNum, '-PLAN.md', cwd); }
function slicePlanReviewPath(mNum, sNum, cwd) { return _slicePath(mNum, sNum, '-PLAN-REVIEW.md', cwd); }
function sliceResearchPath(mNum, sNum, cwd)   { return _slicePath(mNum, sNum, '-RESEARCH.md', cwd); }
function sliceSummaryPath(mNum, sNum, cwd)    { return _slicePath(mNum, sNum, '-SUMMARY.md', cwd); }
function sliceUatPath(mNum, sNum, cwd)        { return _slicePath(mNum, sNum, '-UAT.md', cwd); }

function tasksRoot(mNum, sNum, cwd) {
  return path.join(sliceDir(mNum, sNum, cwd), 'tasks');
}

function taskDir(mNum, sNum, tNum, cwd) {
  return path.join(tasksRoot(mNum, sNum, cwd), tId(tNum));
}

function taskPlanPath(mNum, sNum, tNum, cwd) {
  return path.join(taskDir(mNum, sNum, tNum, cwd), tId(tNum) + '-PLAN.md');
}

function taskSummaryPath(mNum, sNum, tNum, cwd) {
  return path.join(taskDir(mNum, sNum, tNum, cwd), tId(tNum) + '-SUMMARY.md');
}

function _readdirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); }
  catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function findMilestoneDir(mNum, cwd) {
  const root = milestonesRoot(cwd);
  const entries = _readdirSafe(root);
  if (entries === null) return null;
  const want = mId(mNum);
  for (const e of entries) {
    if (e.isDirectory() && e.name === want) return path.join(root, e.name);
  }
  return null;
}

function findSliceDir(mNum, sNum, cwd) {
  const mDir = findMilestoneDir(mNum, cwd);
  if (!mDir) return null;
  const want = sId(sNum);
  const slicesRootDir = path.join(mDir, 'slices');
  const entries = _readdirSafe(slicesRootDir);
  if (entries === null) return null;
  for (const e of entries) {
    if (e.isDirectory() && e.name === want) return path.join(slicesRootDir, e.name);
  }
  return null;
}

function findTaskDir(mNum, sNum, tNum, cwd) {
  const sDir = findSliceDir(mNum, sNum, cwd);
  if (!sDir) return null;
  const want = tId(tNum);
  const tasksRootDir = path.join(sDir, 'tasks');
  const entries = _readdirSafe(tasksRootDir);
  if (entries === null) return null;
  for (const e of entries) {
    if (e.isDirectory() && e.name === want) return path.join(tasksRootDir, e.name);
  }
  return null;
}

function listMilestones(cwd) {
  const entries = _readdirSafe(milestonesRoot(cwd)) || [];
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(M_RE);
    if (m) out.push({ id: e.name, number: Number(m[1]), path: path.join(milestonesRoot(cwd), e.name) });
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

function listSlices(mNum, cwd) {
  const slicesRootDir = slicesRoot(mNum, cwd);
  const entries = _readdirSafe(slicesRootDir) || [];
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(S_RE);
    if (m) out.push({
      id: e.name,
      full_id: sliceFullId(mNum, Number(m[1])),
      number: Number(m[1]),
      path: path.join(slicesRootDir, e.name),
      milestone: mNum,
    });
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

function listTasks(mNum, sNum, cwd) {
  const dir = tasksRoot(mNum, sNum, cwd);
  const entries = _readdirSafe(dir) || [];
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(T_RE);
    if (m) out.push({
      id: e.name,
      full_id: taskFullId(mNum, sNum, Number(m[1])),
      number: Number(m[1]),
      path: path.join(dir, e.name),
      plan_path: path.join(dir, e.name, e.name + '-PLAN.md'),
      summary_path: path.join(dir, e.name, e.name + '-SUMMARY.md'),
      milestone: mNum,
      slice: sNum,
    });
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

function createMilestoneDir(mNum, cwd) {
  const dir = milestoneDir(mNum, cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'slices'), { recursive: true });
  return dir;
}

function createSliceDir(mNum, sNum, cwd) {
  const mDir = milestoneDir(mNum, cwd);
  fs.mkdirSync(path.join(mDir, 'slices'), { recursive: true });
  return withFileLock(path.join(mDir, 'slices', '.slice-create'), () => {
    const target = sliceDir(mNum, sNum, cwd);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, 'tasks'), { recursive: true });
    return target;
  });
}

function createTaskDir(mNum, sNum, tNum, cwd) {
  const sDir = sliceDir(mNum, sNum, cwd);
  fs.mkdirSync(path.join(sDir, 'tasks'), { recursive: true });
  return withFileLock(path.join(sDir, 'tasks', '.task-create'), () => {
    const target = taskDir(mNum, sNum, tNum, cwd);
    fs.mkdirSync(target, { recursive: true });
    return target;
  });
}

module.exports = {
  M_WIDTH, S_WIDTH, T_WIDTH,
  mId, sId, tId,
  sliceFullId, taskFullId,
  parseMId, parseSId, parseTId,
  parseSliceFullId, parseTaskFullId,
  slugify,
  milestonesRoot, milestoneDir,
  milestoneContextPath, milestoneRoadmapPath, milestoneMetaPath,
  slicesRoot, sliceDir,
  sliceAssessmentPath, slicePlanPath, slicePlanReviewPath,
  sliceResearchPath, sliceSummaryPath, sliceUatPath,
  tasksRoot, taskDir, taskPlanPath, taskSummaryPath,
  findMilestoneDir, findSliceDir, findTaskDir,
  listMilestones, listSlices, listTasks,
  createMilestoneDir, createSliceDir, createTaskDir,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  NubosPilotError,
  projectStateDir,
} = require('../../lib/core.cjs');
const layout = require('../../lib/layout.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');
const textMode = require('../../lib/text-mode.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _validateMilestoneArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'execute-milestone-invalid-arg',
      'execute-milestone requires a milestone number',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+$/.test(s)) {
    throw new NubosPilotError(
      'execute-milestone-invalid-arg',
      'Invalid milestone number: ' + s,
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
  const tmpPath = path.join(tmpDir, 'init-execute-milestone-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _readTaskPayload(taskPlanPath) {
  const raw = fs.readFileSync(taskPlanPath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const nameMatch = String(body || '').match(/^#\s+(?:.*?—\s*)?(.+?)\s*$/m);
  return {
    id: frontmatter.id || '',
    slice: frontmatter.slice || '',
    milestone: frontmatter.milestone || '',
    status: frontmatter.status || 'pending',
    tier: frontmatter.tier || 'sonnet',
    wave: typeof frontmatter.wave === 'number' ? frontmatter.wave : null,
    depends_on: Array.isArray(frontmatter.depends_on) ? frontmatter.depends_on : [],
    files_modified: Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [],
    name: nameMatch ? nameMatch[1] : (frontmatter.id || ''),
    plan_path: taskPlanPath,
    summary_path: path.join(path.dirname(taskPlanPath), path.basename(taskPlanPath).replace('-PLAN.md', '-SUMMARY.md')),
  };
}

function _sliceTasksSorted(mNum, sNum, cwd) {
  const tasks = layout.listTasks(mNum, sNum, cwd);
  return tasks.map((t) => {
    if (!fs.existsSync(t.plan_path)) return null;
    return _readTaskPayload(t.plan_path);
  }).filter(Boolean);
}

function _initPayload(mNum, cwd) {
  let def;
  try {
    def = getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'execute-milestone-not-found',
        'Milestone ' + mNum + ' not found in roadmap.yaml',
        { number: mNum },
      );
    }
    throw err;
  }
  const mDirAbs = layout.milestoneDir(mNum, cwd);
  const slices = layout.listSlices(mNum, cwd);
  const waves = [];
  let totalTasks = 0;
  for (const s of slices) {
    const tasks = _sliceTasksSorted(mNum, s.number, cwd);
    totalTasks += tasks.length;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const done = tasks.filter((t) => t.status === 'done').length;
    waves.push({
      wave: s.number,
      slice_id: s.id,
      slice_full_id: s.full_id,
      slice_dir: s.path,
      slice_plan_path: layout.slicePlanPath(mNum, s.number, cwd),
      slice_summary_path: layout.sliceSummaryPath(mNum, s.number, cwd),
      task_count: tasks.length,
      pending,
      done,
      tasks,
    });
  }
  const tmDetail = textMode.resolveTextModeDetail(cwd);

  return {
    _workflow: 'execute-milestone',
    milestone: mNum,
    milestone_id: layout.mId(mNum),
    milestone_dir: mDirAbs,
    milestone_name: def.name || '',
    goal: def.goal || '',
    requirements: Array.isArray(def.requirements) ? def.requirements : [],
    success_criteria: Array.isArray(def.success_criteria) ? def.success_criteria : [],
    waves,
    total_tasks: totalTasks,
    slice_count: slices.length,
    executor_tier: 'sonnet',
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: { executor: _safeSkills('np-executor', cwd) },
  };
}

function _findTaskByFullId(mNum, taskFullId, cwd) {
  let parsed;
  try {
    parsed = layout.parseTaskFullId(taskFullId);
  } catch (err) {
    throw new NubosPilotError(
      'execute-milestone-invalid-task-id',
      'Invalid task full-id (expected M<NNN>-S<NNN>-T<NNNN>): ' + taskFullId,
      { taskId: taskFullId },
    );
  }
  if (parsed.milestone !== mNum) {
    throw new NubosPilotError(
      'execute-milestone-task-milestone-mismatch',
      'Task belongs to milestone M' + String(parsed.milestone).padStart(3, '0') + ' but execution is for milestone M' + String(mNum).padStart(3, '0'),
      { task: taskFullId, milestone: mNum, task_milestone: parsed.milestone },
    );
  }
  const taskPlanPath = layout.taskPlanPath(mNum, parsed.slice, parsed.task, cwd);
  if (!fs.existsSync(taskPlanPath)) {
    throw new NubosPilotError(
      'execute-milestone-task-not-found',
      'Task ' + taskFullId + ' plan file not found at ' + taskPlanPath,
      { taskId: taskFullId, path: taskPlanPath },
    );
  }
  const p = _readTaskPayload(taskPlanPath);
  return {
    _workflow: 'execute-milestone',
    verb: 'execute-task',
    milestone: mNum,
    milestone_id: layout.mId(mNum),
    slice_id: layout.sId(parsed.slice),
    slice_full_id: layout.sliceFullId(mNum, parsed.slice),
    task_id: taskFullId,
    task_dir: layout.taskDir(mNum, parsed.slice, parsed.task, cwd),
    plan_path: p.plan_path,
    summary_path: p.summary_path,
    slice_plan_path: layout.slicePlanPath(mNum, parsed.slice, cwd),
    task_name: p.name,
    tier: p.tier,
    wave: p.wave,
    depends_on: p.depends_on,
    files_modified: p.files_modified,
    executor_tier: 'sonnet',
    agent_skills: { executor: _safeSkills('np-executor', cwd) },
  };
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
    case 'execute-task': {
      const mNum = _validateMilestoneArg(list[1]);
      const taskId = list[2];
      if (!taskId) {
        throw new NubosPilotError(
          'execute-milestone-missing-task-id',
          'execute-task requires <task-full-id> (e.g. M001-S001-T0001)',
          {},
        );
      }
      const payload = _findTaskByFullId(mNum, taskId, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    default:
      throw new NubosPilotError(
        'execute-milestone-unknown-verb',
        'execute-milestone: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };

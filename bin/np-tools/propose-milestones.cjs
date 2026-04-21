'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  NubosPilotError,
  atomicWriteFileSync,
  withFileLock,
} = require('../../lib/core.cjs');
const layout = require('../../lib/layout.cjs');
const { readState } = require('../../lib/state.cjs');
const textMode = require('../../lib/text-mode.cjs');

const TBD_RE = /<!--\s*TBD[^>]*-->/gi;
const DONE_STATUSES = new Set(['done', 'complete', 'completed']);

function _emit(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2));
}

function _guardInitialized(root) {
  const projectMd = path.join(root, '.nubos-pilot', 'PROJECT.md');
  if (!fs.existsSync(projectMd)) {
    throw new NubosPilotError(
      'project-not-initialized',
      'PROJECT.md not found — run np:new-project first',
      { hint: 'Run np:new-project first', path: projectMd },
    );
  }
}

function _readRoadmap(root) {
  const p = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  if (!fs.existsSync(p)) {
    throw new NubosPilotError(
      'roadmap-missing',
      'roadmap.yaml not found',
      { path: p },
    );
  }
  const raw = fs.readFileSync(p, 'utf-8');
  let doc;
  try { doc = YAML.parse(raw); } catch (err) {
    throw new NubosPilotError(
      'roadmap-parse-error',
      'roadmap.yaml invalid YAML',
      { path: p, cause: err && err.message },
    );
  }
  if (!doc || !Array.isArray(doc.milestones)) {
    throw new NubosPilotError(
      'roadmap-parse-error',
      'roadmap.yaml missing milestones array',
      { path: p },
    );
  }
  return { doc, path: p };
}

function _classifyMilestone(m, root, stateMilestoneId) {
  if (!m || m.id === 'backlog') return null;
  const status = typeof m.status === 'string' ? m.status : 'pending';
  const isDone = DONE_STATUSES.has(status);
  const slices = Array.isArray(m.slices) ? m.slices : [];
  const hasSlices = slices.length > 0;

  const mNumMatch = typeof m.id === 'string' ? m.id.match(/^M(\d+)$/) : null;
  const mNum = mNumMatch ? Number(mNumMatch[1]) : (typeof m.number === 'number' ? m.number : null);

  let contextSummary = null;
  let contextHasContent = false;
  if (mNum != null) {
    const ctxPath = layout.milestoneContextPath(mNum, root);
    if (fs.existsSync(ctxPath)) {
      const raw = fs.readFileSync(ctxPath, 'utf-8');
      const tbdSections = (raw.match(TBD_RE) || []).length;
      const contentSections = (raw.match(/^<[a-z_]+>$/gm) || []).length;
      contextHasContent = contentSections > 0 && tbdSections === 0;
      contextSummary = {
        path: ctxPath,
        byte_size: raw.length,
        tbd_sections: tbdSections,
        content_sections: contentSections,
        has_content: contextHasContent,
      };
    }
  }

  const isActive = stateMilestoneId && m.id === stateMilestoneId;

  let classification;
  if (isDone) classification = 'completed';
  else if (hasSlices || isActive) classification = 'active';
  else if (contextHasContent) classification = 'discussed';
  else classification = 'empty';

  return {
    id: m.id,
    number: mNum,
    name: m.name || '',
    goal: typeof m.goal === 'string' ? m.goal : '',
    status,
    classification,
    slice_count: slices.length,
    context: contextSummary,
    touchable: classification === 'empty',
    modification_requires_confirm: classification === 'active' || classification === 'discussed',
  };
}

function _nextMilestoneNumber(doc) {
  let maxNum = 0;
  for (const m of doc.milestones || []) {
    if (!m) continue;
    if (m.id === 'backlog') continue;
    if (typeof m.number === 'number' && Number.isInteger(m.number) && m.number > maxNum) {
      maxNum = m.number;
    }
    if (typeof m.id === 'string') {
      const mm = m.id.match(/^M(\d+)$/);
      if (mm) {
        const n = Number(mm[1]);
        if (Number.isInteger(n) && n > maxNum) maxNum = n;
      }
    }
  }
  return maxNum + 1;
}

function _interviewPayload(cwd) {
  const root = path.resolve(cwd);
  _guardInitialized(root);
  const { doc } = _readRoadmap(root);

  let stateMilestoneId = null;
  try {
    const st = readState(root);
    stateMilestoneId = st && st.frontmatter && st.frontmatter.milestone || null;
  } catch {
    stateMilestoneId = null;
  }

  const classified = [];
  for (const m of doc.milestones) {
    const row = _classifyMilestone(m, root, stateMilestoneId);
    if (row) classified.push(row);
  }

  const projectMd = fs.readFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  const reqPath = path.join(root, '.nubos-pilot', 'REQUIREMENTS.md');
  const reqMd = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : '';

  const projectHasTbd = /_TBD — filled by \/np:discuss-project\._/.test(projectMd);

  const tmDetail = textMode.resolveTextModeDetail(cwd);

  return {
    _workflow: 'propose-milestones',
    mode: 'interview',
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    project_md_path: path.join(root, '.nubos-pilot', 'PROJECT.md'),
    requirements_md_path: reqPath,
    project_md: projectMd,
    requirements_md: reqMd,
    project_has_tbd: projectHasTbd,
    current_state_milestone: stateMilestoneId,
    milestones: classified,
    next_milestone_number: _nextMilestoneNumber(doc),
    guidance: {
      completed: 'Untouchable — never modify or remove; displayed for context only.',
      active: 'Has slices or is the current state pointer — modifications require explicit per-item confirm.',
      discussed: 'Has non-TBD CONTEXT.md content — modifications require explicit per-item confirm.',
      empty: 'No slices, CONTEXT.md still TBD — freely modifiable or removable.',
    },
  };
}

function _validateOperation(op, idx) {
  if (!op || typeof op !== 'object') {
    throw new NubosPilotError(
      'invalid-operation',
      'operation ' + idx + ' is not an object',
      { index: idx },
    );
  }
  const type = op.type;
  if (!['add', 'update', 'remove'].includes(type)) {
    throw new NubosPilotError(
      'invalid-operation-type',
      'operation ' + idx + ' has unknown type: ' + String(type),
      { index: idx, type },
    );
  }
  if (type === 'add') {
    if (typeof op.milestone_name !== 'string' || op.milestone_name.trim() === '') {
      throw new NubosPilotError('answers-missing-field', 'op[' + idx + '].milestone_name required', { index: idx });
    }
    if (typeof op.milestone_goal !== 'string' || op.milestone_goal.trim() === '') {
      throw new NubosPilotError('answers-missing-field', 'op[' + idx + '].milestone_goal required', { index: idx });
    }
  } else {
    if (typeof op.milestone_id !== 'string' || !/^M\d+$/.test(op.milestone_id)) {
      throw new NubosPilotError('answers-missing-field', 'op[' + idx + '].milestone_id required (format M<NNN>)', { index: idx });
    }
    if (type === 'update') {
      const hasName = typeof op.new_name === 'string' && op.new_name.trim() !== '';
      const hasGoal = typeof op.new_goal === 'string' && op.new_goal.trim() !== '';
      if (!hasName && !hasGoal) {
        throw new NubosPilotError('answers-missing-field', 'op[' + idx + '] update needs new_name or new_goal', { index: idx });
      }
    }
  }
}

function _findMilestone(doc, id) {
  return doc.milestones.find((m) => m && m.id === id);
}

function _assertTouchable(m, opType, confirmForceModify) {
  const status = typeof m.status === 'string' ? m.status : 'pending';
  if (DONE_STATUSES.has(status)) {
    throw new NubosPilotError(
      'milestone-completed-untouchable',
      'Milestone ' + m.id + ' is completed (status=' + status + ') — cannot ' + opType,
      { id: m.id, status },
    );
  }
  const slices = Array.isArray(m.slices) ? m.slices : [];
  if (slices.length > 0 && !confirmForceModify) {
    throw new NubosPilotError(
      'milestone-has-slices',
      'Milestone ' + m.id + ' has ' + slices.length + ' slice(s); ' + opType + ' requires confirm_force_modify=true',
      { id: m.id, slice_count: slices.length },
    );
  }
}

function _applyAdd(doc, op) {
  const mNum = _nextMilestoneNumber(doc);
  const id = layout.mId(mNum);
  doc.milestones.push({
    id,
    number: mNum,
    name: op.milestone_name,
    goal: op.milestone_goal,
    status: 'pending',
    requirements: [],
    success_criteria: [],
    slices: [],
  });
  return { type: 'add', id, number: mNum, name: op.milestone_name };
}

function _applyUpdate(doc, op) {
  const m = _findMilestone(doc, op.milestone_id);
  if (!m) {
    throw new NubosPilotError('milestone-not-found', 'milestone ' + op.milestone_id + ' not found', { id: op.milestone_id });
  }
  _assertTouchable(m, 'update', op.confirm_force_modify === true);
  const changed = {};
  if (typeof op.new_name === 'string' && op.new_name.trim() !== '') {
    changed.from_name = m.name;
    m.name = op.new_name;
    changed.to_name = m.name;
  }
  if (typeof op.new_goal === 'string' && op.new_goal.trim() !== '') {
    changed.from_goal = m.goal;
    m.goal = op.new_goal;
    changed.to_goal = m.goal;
  }
  return { type: 'update', id: m.id, changed };
}

function _applyRemove(doc, op, root) {
  const idx = doc.milestones.findIndex((m) => m && m.id === op.milestone_id);
  if (idx < 0) {
    throw new NubosPilotError('milestone-not-found', 'milestone ' + op.milestone_id + ' not found', { id: op.milestone_id });
  }
  const m = doc.milestones[idx];
  _assertTouchable(m, 'remove', op.confirm_force_modify === true);
  doc.milestones.splice(idx, 1);

  let archivedTo = null;
  const mNumMatch = m.id.match(/^M(\d+)$/);
  if (mNumMatch) {
    const mNum = Number(mNumMatch[1]);
    const srcDir = layout.milestoneDir(mNum, root);
    if (fs.existsSync(srcDir)) {
      const archRoot = path.join(root, '.nubos-pilot', 'archive', 'milestones');
      fs.mkdirSync(archRoot, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const target = path.join(archRoot, m.id + '-' + stamp);
      fs.renameSync(srcDir, target);
      archivedTo = target;
    }
  }
  return { type: 'remove', id: m.id, archived_to: archivedTo };
}

function _apply(answersPath, cwd, stdout) {
  let raw;
  try { raw = fs.readFileSync(answersPath, 'utf-8'); } catch (err) {
    throw new NubosPilotError(
      'answers-not-readable',
      'answers file not readable: ' + answersPath,
      { path: answersPath, cause: err && err.code },
    );
  }
  let answers;
  try { answers = JSON.parse(raw); } catch (err) {
    throw new NubosPilotError(
      'answers-parse-error',
      'answers file is not valid JSON',
      { path: answersPath, cause: err && err.message },
    );
  }
  if (!answers || !Array.isArray(answers.operations)) {
    throw new NubosPilotError(
      'answers-missing-field',
      'answers.operations must be an array',
      {},
    );
  }
  answers.operations.forEach(_validateOperation);

  const root = path.resolve(cwd);
  _guardInitialized(root);

  const roadmapPath = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  const results = withFileLock(roadmapPath, () => {
    const rawYaml = fs.readFileSync(roadmapPath, 'utf-8');
    let doc;
    try { doc = YAML.parse(rawYaml); } catch (err) {
      throw new NubosPilotError('roadmap-parse-error', 'roadmap.yaml invalid YAML', { path: roadmapPath, cause: err && err.message });
    }
    if (!doc || !Array.isArray(doc.milestones)) {
      throw new NubosPilotError('roadmap-parse-error', 'roadmap.yaml missing milestones array', { path: roadmapPath });
    }

    const out = [];
    for (const op of answers.operations) {
      if (op.type === 'add') out.push(_applyAdd(doc, op));
      else if (op.type === 'update') out.push(_applyUpdate(doc, op));
      else if (op.type === 'remove') out.push(_applyRemove(doc, op, root));
    }

    atomicWriteFileSync(roadmapPath, YAML.stringify(doc, { indent: 2 }));

    for (const result of out) {
      if (result.type === 'add') {
        _writeMilestoneArtefacts(root, result.number, result.name, doc);
      }
    }

    return out;
  });

  _emit(stdout, {
    mode: 'apply',
    results,
  });
}

function _writeMilestoneArtefacts(root, mNum, name, doc) {
  const { _render, _loadTemplate } = _lazyRenderer();
  const m = doc.milestones.find((x) => x && x.id === layout.mId(mNum));
  const goal = m && m.goal || '';
  layout.createMilestoneDir(mNum, root);
  const mIdStr = layout.mId(mNum);
  const createdDate = new Date().toISOString().slice(0, 10);
  const ctxVars = {
    milestone_id: mIdStr,
    milestone_name: name,
    created_date: createdDate,
    goal_text: goal,
    decisions_text: '<!-- TBD: locked decisions from /np:discuss-phase -->',
    deferred_text: '<!-- TBD: deferred ideas -->',
    domain_text: '<!-- TBD: domain boundary -->',
    canonical_refs_text: '<!-- TBD: canonical references -->',
  };
  const roadmapVars = {
    milestone_id: mIdStr,
    milestone_name: name,
    created_date: createdDate,
    slices_text: '<!-- TBD: slices will be appended by /np:plan-phase ' + mNum + ' -->',
  };
  const metaVars = {
    milestone_id: mIdStr,
    milestone_name: JSON.stringify(name).slice(1, -1),
    status: 'pending',
    created_date: createdDate,
    goal_text_escaped: JSON.stringify(goal).slice(1, -1),
    requirements_json: '[]',
    success_criteria_json: '[]',
    slice_count: 0,
    task_count: 0,
  };
  _writeFile(layout.milestoneContextPath(mNum, root), _render(_loadTemplate('CONTEXT.md'), ctxVars, 'milestone/CONTEXT.md'));
  _writeFile(layout.milestoneRoadmapPath(mNum, root), _render(_loadTemplate('ROADMAP.md'), roadmapVars, 'milestone/ROADMAP.md'));
  _writeFile(layout.milestoneMetaPath(mNum, root), _render(_loadTemplate('META.json'), metaVars, 'milestone/META.json'));
}

function _writeFile(target, content) {
  if (path.basename(target) === 'PROJECT.md') {
    throw new NubosPilotError(
      'propose-milestones-forbidden-write',
      'propose-milestones is never allowed to write PROJECT.md (D-29)',
      { path: target },
    );
  }
  atomicWriteFileSync(target, content);
}

function _lazyRenderer() {
  const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'milestone');
  const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  function _render(raw, vars, templateName) {
    return raw.replace(PLACEHOLDER_RE, (_match, key) => {
      if (!(key in vars)) {
        throw new NubosPilotError(
          'template-unresolved-var',
          'Undefined placeholder {{' + key + '}} in template "' + templateName + '"',
          { template: templateName, variable: key, available: Object.keys(vars) },
        );
      }
      return String(vars[key]);
    });
  }
  function _loadTemplate(name) {
    return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
  }
  return { _render, _loadTemplate };
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const argv = args || [];

  const applyIdx = argv.indexOf('--apply');
  if (applyIdx >= 0) {
    const answersPath = argv[applyIdx + 1];
    if (!answersPath) {
      throw new NubosPilotError(
        'missing-apply-path',
        '--apply requires a path to the answers JSON file',
        { args: argv.slice() },
      );
    }
    _apply(answersPath, cwd, stdout);
    return;
  }

  _emit(stdout, _interviewPayload(cwd));
}

module.exports = { run, _interviewPayload };

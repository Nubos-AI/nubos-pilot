'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  NubosPilotError,
  atomicWriteFileSync,
  withFileLock,
  projectStateDir,
} = require('../../lib/core.cjs');
const { parseRoadmap } = require('../../lib/roadmap.cjs');
const { mutateState } = require('../../lib/state.cjs');
const layout = require('../../lib/layout.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'milestone');
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function _render(raw, vars, templateName) {
  return raw.replace(PLACEHOLDER_RE, (_match, key) => {
    if (!(key in vars)) {
      throw new NubosPilotError(
        'template-unresolved-var',
        `Undefined placeholder {{${key}}} in template "${templateName}"`,
        { template: templateName, variable: key, available: Object.keys(vars) },
      );
    }
    return String(vars[key]);
  });
}

function _loadTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
}

function _writeFile(target, content) {
  if (path.basename(target) === 'PROJECT.md') {
    throw new NubosPilotError(
      'new-milestone-forbidden-write',
      'new-milestone.cjs is never allowed to write PROJECT.md (D-29)',
      { path: target },
    );
  }
  atomicWriteFileSync(target, content);
}

function _emit(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2));
}

function _interviewPayload() {
  return {
    mode: 'interview',
    questions: [
      { key: 'milestone_name', type: 'input',
        question: 'Milestone name (e.g. "Auth & Basic UI")?' },
      { key: 'milestone_goal', type: 'input',
        question: 'Milestone goal — one sentence describing what ships in this milestone?' },
      { key: 'create_req_prefix', type: 'confirm',
        question: 'Create a new "## <milestone> Requirements" section in REQUIREMENTS.md?' },
    ],
  };
}

function _validateAnswers(a) {
  for (const key of ['milestone_name', 'milestone_goal']) {
    if (typeof a[key] !== 'string' || a[key].trim() === '') {
      throw new NubosPilotError(
        'answers-missing-field',
        'answers JSON missing field: ' + key,
        { field: key },
      );
    }
  }
  if ('create_req_prefix' in a && typeof a.create_req_prefix !== 'boolean') {
    throw new NubosPilotError(
      'answers-invalid-field',
      'create_req_prefix must be a boolean',
      { field: 'create_req_prefix', value: a.create_req_prefix },
    );
  }
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

function _appendReqPrefix(root, milestoneName) {
  const reqPath = path.join(root, '.nubos-pilot', 'REQUIREMENTS.md');
  const current = fs.readFileSync(reqPath, 'utf-8');
  const header = `\n## ${milestoneName} Requirements\n\n<!-- TBD: first requirement -->\n- [ ] **REQ-TBD**: TBD\n`;
  const marker = '\n## Out of Scope';
  const idx = current.indexOf(marker);
  const next = idx >= 0
    ? current.slice(0, idx) + header + current.slice(idx)
    : (current.endsWith('\n') ? current : current + '\n') + header;
  _writeFile(reqPath, next);
}

function _nextMilestoneNumber(root) {
  let maxNum = 0;
  try {
    const { doc } = parseRoadmap(root);
    if (doc && Array.isArray(doc.milestones)) {
      for (const m of doc.milestones) {
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
    }
  } catch {
    maxNum = 0;
  }
  return maxNum + 1;
}

function _addMilestoneToRoadmap(root, mNum, answers) {
  const roadmapPath = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  return withFileLock(roadmapPath, () => {
    let doc;
    if (fs.existsSync(roadmapPath)) {
      const raw = fs.readFileSync(roadmapPath, 'utf-8');
      try { doc = YAML.parse(raw); } catch {
        throw new NubosPilotError('roadmap-parse-error', 'roadmap.yaml invalid YAML', { path: roadmapPath });
      }
    }
    if (!doc || typeof doc !== 'object') doc = { schema_version: 1, milestones: [] };
    if (!Array.isArray(doc.milestones)) doc.milestones = [];
    const id = layout.mId(mNum);
    if (doc.milestones.some((m) => m && m.id === id)) {
      throw new NubosPilotError(
        'roadmap-duplicate-milestone',
        'Milestone with id ' + id + ' already exists',
        { id },
      );
    }
    doc.milestones.push({
      id,
      number: mNum,
      name: answers.milestone_name,
      goal: answers.milestone_goal,
      status: 'pending',
      requirements: [],
      success_criteria: [],
      slices: [],
    });
    atomicWriteFileSync(roadmapPath, YAML.stringify(doc, { indent: 2 }));
    return { id, number: mNum };
  });
}

function _writeMilestoneArtefacts(root, mNum, answers) {
  layout.createMilestoneDir(mNum, root);
  const mIdStr = layout.mId(mNum);
  const createdDate = new Date().toISOString().slice(0, 10);
  const ctxVars = {
    milestone_id: mIdStr,
    milestone_name: answers.milestone_name,
    created_date: createdDate,
    goal_text: answers.milestone_goal,
    decisions_text: '<!-- TBD: locked decisions from /np:discuss-phase -->',
    deferred_text: '<!-- TBD: deferred ideas -->',
    domain_text: '<!-- TBD: domain boundary -->',
    canonical_refs_text: '<!-- TBD: canonical references -->',
  };
  const roadmapVars = {
    milestone_id: mIdStr,
    milestone_name: answers.milestone_name,
    created_date: createdDate,
    slices_text: '<!-- TBD: slices will be appended by /np:plan-phase ' + mNum + ' -->',
  };
  const metaVars = {
    milestone_id: mIdStr,
    milestone_name: JSON.stringify(answers.milestone_name).slice(1, -1),
    status: 'pending',
    created_date: createdDate,
    goal_text_escaped: JSON.stringify(answers.milestone_goal).slice(1, -1),
    requirements_json: '[]',
    success_criteria_json: '[]',
    slice_count: 0,
    task_count: 0,
  };
  _writeFile(layout.milestoneContextPath(mNum, root), _render(_loadTemplate('CONTEXT.md'), ctxVars, 'milestone/CONTEXT.md'));
  _writeFile(layout.milestoneRoadmapPath(mNum, root), _render(_loadTemplate('ROADMAP.md'), roadmapVars, 'milestone/ROADMAP.md'));
  _writeFile(layout.milestoneMetaPath(mNum, root), _render(_loadTemplate('META.json'), metaVars, 'milestone/META.json'));
}

function _apply(answersPath, cwd, stdout) {
  let raw;
  try {
    raw = fs.readFileSync(answersPath, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'answers-not-readable',
      'answers file not readable: ' + answersPath,
      { path: answersPath, cause: err && err.code },
    );
  }
  let answers;
  try {
    answers = JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'answers-parse-error',
      'answers file is not valid JSON',
      { path: answersPath, cause: err && err.message },
    );
  }
  _validateAnswers(answers);

  const root = path.resolve(cwd);
  _guardInitialized(root);

  const mNum = _nextMilestoneNumber(root);
  const mIdStr = layout.mId(mNum);

  _addMilestoneToRoadmap(root, mNum, answers);
  _writeMilestoneArtefacts(root, mNum, answers);

  if (answers.create_req_prefix === true) {
    _appendReqPrefix(root, answers.milestone_name);
  }

  mutateState((state) => {
    const fm = Object.assign({}, state.frontmatter, {
      milestone: mIdStr,
      milestone_number: mNum,
      milestone_name: answers.milestone_name,
      current_slice: null,
      current_task: null,
      last_updated: new Date().toISOString(),
    });
    return { frontmatter: fm, body: state.body };
  }, root);

  projectStateDir(root);

  _emit(stdout, {
    mode: 'apply',
    milestone_id: mIdStr,
    milestone_number: mNum,
    milestone_name: answers.milestone_name,
    milestone_dir: layout.milestoneDir(mNum, root),
    created_req_prefix: answers.create_req_prefix === true,
  });
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

  _emit(stdout, _interviewPayload());
}

module.exports = { run, _interviewPayload };

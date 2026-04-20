'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  NubosPilotError,
  atomicWriteFileSync,
} = require('../../lib/core.cjs');
const { writeState } = require('../../lib/state.cjs');
const layout = require('../../lib/layout.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
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
  return fs.readFileSync(path.join(TEMPLATES_DIR, name + '.md'), 'utf-8');
}

function _slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function _todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function _interviewPayload() {
  return {
    mode: 'interview',
    questions: [
      { key: 'project_name', type: 'input',
        question: 'Project name?' },
      { key: 'core_value', type: 'input',
        question: 'Core value — one sentence that must stay true if everything else fails?' },
      { key: 'primary_constraints', type: 'input',
        question: 'Primary constraints (comma-separated, e.g. "Node 22; markdown-first")?' },
      { key: 'first_milestone_name', type: 'input',
        question: 'First milestone name (e.g. "Auth & Basic UI")?' },
      { key: 'first_milestone_goal', type: 'input',
        question: 'First milestone goal — one sentence describing what ships?' },
    ],
  };
}

function _validateAnswers(a) {
  const required = ['project_name', 'core_value', 'primary_constraints', 'first_milestone_name'];
  for (const key of required) {
    if (typeof a[key] !== 'string' || a[key].trim() === '') {
      throw new NubosPilotError(
        'answers-missing-field',
        'answers JSON missing field: ' + key,
        { field: key },
      );
    }
  }
  if ((typeof a.first_milestone_goal !== 'string' || a.first_milestone_goal.trim() === '') &&
      (typeof a.first_phase_name !== 'string' || a.first_phase_name.trim() === '')) {
    throw new NubosPilotError(
      'answers-missing-field',
      'answers JSON missing field: first_milestone_goal',
      { field: 'first_milestone_goal' },
    );
  }
}

function _emit(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2));
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
  const stateDir = path.join(root, '.nubos-pilot');
  const projectMd = path.join(stateDir, 'PROJECT.md');

  if (fs.existsSync(projectMd)) {
    throw new NubosPilotError(
      'project-already-initialized',
      'PROJECT.md already exists — refusing to overwrite',
      { path: projectMd },
    );
  }

  const firstMilestoneName = answers.first_milestone_name;
  const firstMilestoneGoal = answers.first_milestone_goal || answers.first_phase_name || '';
  const createdDate = _todayIso();
  const firstMilestoneNumber = 1;
  const firstMilestoneId = layout.mId(firstMilestoneNumber);

  fs.mkdirSync(stateDir, { recursive: true });

  const roadmapYamlPath = path.join(stateDir, 'roadmap.yaml');
  const initialRoadmap = {
    schema_version: 2,
    milestones: [
      {
        id: firstMilestoneId,
        number: firstMilestoneNumber,
        name: firstMilestoneName,
        goal: firstMilestoneGoal,
        status: 'pending',
        requirements: [],
        success_criteria: [],
        slices: [],
      },
    ],
  };
  atomicWriteFileSync(roadmapYamlPath, YAML.stringify(initialRoadmap, { indent: 2 }));

  const projectVars = {
    project_name: answers.project_name,
    core_value: answers.core_value,
    primary_constraints: answers.primary_constraints,
    first_milestone_name: firstMilestoneName,
    first_phase_name: firstMilestoneName,
    created_date: createdDate,
    project_description: '_TBD — filled by `/np:discuss-project`._',
    domain_text: '_TBD — filled by `/np:discuss-project`._',
    target_users_text: '_TBD — filled by `/np:discuss-project`._',
    non_goals_text: '_TBD — filled by `/np:discuss-project`._',
    success_criteria_text: '_TBD — filled by `/np:discuss-project`._',
    strategic_decisions_text: '_TBD — filled by `/np:discuss-project`._',
  };
  atomicWriteFileSync(projectMd, _render(_loadTemplate('PROJECT'), projectVars, 'PROJECT'));

  const reqVars = {
    project_name: answers.project_name,
    core_value: answers.core_value,
    first_milestone_name: firstMilestoneName,
    created_date: createdDate,
  };
  atomicWriteFileSync(
    path.join(stateDir, 'REQUIREMENTS.md'),
    _render(_loadTemplate('REQUIREMENTS'), reqVars, 'REQUIREMENTS'),
  );

  layout.createMilestoneDir(firstMilestoneNumber, root);
  const msTemplatesDir = path.join(TEMPLATES_DIR, 'milestone');
  const msCtx = _render(
    fs.readFileSync(path.join(msTemplatesDir, 'CONTEXT.md'), 'utf-8'),
    {
      milestone_id: firstMilestoneId,
      milestone_name: firstMilestoneName,
      created_date: createdDate,
      goal_text: firstMilestoneGoal,
      decisions_text: '<!-- TBD: locked decisions from /np:discuss-phase -->',
      deferred_text: '<!-- TBD: deferred ideas -->',
      domain_text: '<!-- TBD: domain boundary -->',
      canonical_refs_text: '<!-- TBD: canonical references -->',
    },
    'milestone/CONTEXT.md',
  );
  const msRoadmap = _render(
    fs.readFileSync(path.join(msTemplatesDir, 'ROADMAP.md'), 'utf-8'),
    {
      milestone_id: firstMilestoneId,
      milestone_name: firstMilestoneName,
      created_date: createdDate,
      slices_text: '<!-- TBD: slices will be appended by /np:plan-phase ' + firstMilestoneNumber + ' -->',
    },
    'milestone/ROADMAP.md',
  );
  const msMeta = _render(
    fs.readFileSync(path.join(msTemplatesDir, 'META.json'), 'utf-8'),
    {
      milestone_id: firstMilestoneId,
      milestone_name: JSON.stringify(firstMilestoneName).slice(1, -1),
      status: 'pending',
      created_date: createdDate,
      goal_text_escaped: JSON.stringify(firstMilestoneGoal).slice(1, -1),
      requirements_json: '[]',
      success_criteria_json: '[]',
      slice_count: 0,
      task_count: 0,
    },
    'milestone/META.json',
  );
  atomicWriteFileSync(layout.milestoneContextPath(firstMilestoneNumber, root), msCtx);
  atomicWriteFileSync(layout.milestoneRoadmapPath(firstMilestoneNumber, root), msRoadmap);
  atomicWriteFileSync(layout.milestoneMetaPath(firstMilestoneNumber, root), msMeta);

  writeState(
    {
      frontmatter: {
        schema_version: 2,
        milestone: firstMilestoneId,
        milestone_number: firstMilestoneNumber,
        milestone_name: firstMilestoneName,
        current_slice: null,
        current_task: null,
        last_updated: new Date().toISOString(),
        progress: {
          total_milestones: 1,
          completed_milestones: 0,
          total_slices: 0,
          completed_slices: 0,
          total_tasks: 0,
          completed_tasks: 0,
          percent: 0,
        },
        session: {
          stopped_at: null,
          resume_file: null,
          last_activity: createdDate + ' -- np:new-project scaffold',
        },
      },
      body: '\n# Project State\n\nInitialized by np:new-project.\n',
    },
    root,
  );

  _emit(stdout, {
    mode: 'apply',
    milestone_id: firstMilestoneId,
    milestone_number: firstMilestoneNumber,
    milestone_name: firstMilestoneName,
    milestone_dir: layout.milestoneDir(firstMilestoneNumber, root),
    created: [
      '.nubos-pilot/PROJECT.md',
      '.nubos-pilot/REQUIREMENTS.md',
      '.nubos-pilot/roadmap.yaml',
      '.nubos-pilot/STATE.md',
      path.relative(root, layout.milestoneContextPath(firstMilestoneNumber, root)),
      path.relative(root, layout.milestoneRoadmapPath(firstMilestoneNumber, root)),
      path.relative(root, layout.milestoneMetaPath(firstMilestoneNumber, root)),
    ],
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

module.exports = { run, _interviewPayload, _slugify };

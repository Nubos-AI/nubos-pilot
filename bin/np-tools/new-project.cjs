const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  NubosPilotError,
  atomicWriteFileSync,
} = require('../../lib/core.cjs');
const { addMilestone, addPhase } = require('../../lib/roadmap.cjs');
const { createPhaseDir, phaseSlug } = require('../../lib/phase.cjs');
const { writeState } = require('../../lib/state.cjs');

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
        question: 'First milestone name (e.g. "v1.0")?' },
      { key: 'first_phase_name', type: 'input',
        question: 'First phase name (will be slugified for the directory)?' },
    ],
  };
}

function _validateAnswers(a) {
  for (const key of [
    'project_name',
    'core_value',
    'primary_constraints',
    'first_milestone_name',
    'first_phase_name',
  ]) {
    if (typeof a[key] !== 'string' || a[key].trim() === '') {
      throw new NubosPilotError(
        'answers-missing-field',
        'answers JSON missing field: ' + key,
        { field: key },
      );
    }
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

  const milestoneId = _slugify(answers.first_milestone_name);
  if (milestoneId === '') {
    throw new NubosPilotError(
      'invalid-slug',
      'first_milestone_name slugifies to empty string',
      { value: answers.first_milestone_name, field: 'first_milestone_name' },
    );
  }
  const phaseSlugValue = phaseSlug(answers.first_phase_name);
  if (phaseSlugValue === '') {
    throw new NubosPilotError(
      'invalid-slug',
      'first_phase_name slugifies to empty string',
      { value: answers.first_phase_name, field: 'first_phase_name' },
    );
  }

  const createdDate = _todayIso();

  

  

  fs.mkdirSync(stateDir, { recursive: true });
  const roadmapYamlPath = path.join(stateDir, 'roadmap.yaml');
  const emptyRoadmap = { schema_version: 1, milestones: [] };
  atomicWriteFileSync(roadmapYamlPath, YAML.stringify(emptyRoadmap, { indent: 2 }));

  

  const projectVars = {
    project_name: answers.project_name,
    core_value: answers.core_value,
    primary_constraints: answers.primary_constraints,
    first_milestone_name: answers.first_milestone_name,
    first_phase_name: answers.first_phase_name,
    created_date: createdDate,
  };
  atomicWriteFileSync(projectMd, _render(_loadTemplate('PROJECT'), projectVars, 'PROJECT'));

  

  const reqVars = {
    project_name: answers.project_name,
    core_value: answers.core_value,
    first_milestone_name: answers.first_milestone_name,
    created_date: createdDate,
  };
  atomicWriteFileSync(
    path.join(stateDir, 'REQUIREMENTS.md'),
    _render(_loadTemplate('REQUIREMENTS'), reqVars, 'REQUIREMENTS'),
  );

  

  
  addMilestone({ id: milestoneId, name: answers.first_milestone_name, phases: [] }, root);
  const phaseResult = addPhase(
    milestoneId,
    {
      slug: phaseSlugValue,
      name: answers.first_phase_name,
      goal: '',
      depends_on: [],
      requirements: [],
      success_criteria: [],
      status: 'pending',
      plans: [],
    },
    root,
  );

  

  const phaseDir = createPhaseDir(phaseResult.number, phaseSlugValue, root);
  const ctxVars = {
    phase_number: String(phaseResult.number),
    phase_name: answers.first_phase_name,
    phase_padded: String(phaseResult.number).padStart(2, '0'),
    phase_slug: phaseSlugValue,
    created_date: createdDate,
    domain_text: '<!-- TBD: phase boundary -->',
    decisions_text: '<!-- TBD: decisions -->',
    canonical_refs_text: '<!-- TBD: canonical references -->',
    code_context_text: '<!-- TBD: existing code insights -->',
    specifics_text: '<!-- TBD: specific ideas / references -->',
    deferred_text: '<!-- TBD: deferred ideas -->',
  };
  const contextMdPath = path.join(
    phaseDir,
    String(phaseResult.number).padStart(2, '0') + '-CONTEXT.md',
  );
  atomicWriteFileSync(contextMdPath, _render(_loadTemplate('CONTEXT'), ctxVars, 'CONTEXT'));

  

  writeState(
    {
      frontmatter: {
        schema_version: 2,
        milestone: milestoneId,
        milestone_name: answers.first_milestone_name,
        current_phase: Number(phaseResult.number),
        current_plan: null,
        current_task: null,
        last_updated: new Date().toISOString(),
        progress: {
          total_phases: 1,
          completed_phases: 0,
          total_plans: 0,
          completed_plans: 0,
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
    milestoneId,
    firstPhaseNumber: phaseResult.number,
    firstPhaseSlug: phaseSlugValue,
    created: [
      '.nubos-pilot/PROJECT.md',
      '.nubos-pilot/REQUIREMENTS.md',
      '.nubos-pilot/roadmap.yaml',
      '.nubos-pilot/ROADMAP.md',
      '.nubos-pilot/STATE.md',
      path.relative(root, contextMdPath),
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

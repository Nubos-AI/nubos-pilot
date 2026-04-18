const fs = require('node:fs');
const path = require('node:path');

const {
  NubosPilotError,
  atomicWriteFileSync,
  projectStateDir,
} = require('../../lib/core.cjs');
const { addMilestone, addPhase, parseRoadmap } = require('../../lib/roadmap.cjs');
const { createPhaseDir, phaseSlug } = require('../../lib/phase.cjs');
const { mutateState } = require('../../lib/state.cjs');

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
        question: 'Milestone name (e.g. "v2.0")?' },
      { key: 'milestone_goal', type: 'input',
        question: 'Milestone goal — one sentence describing what ships in this milestone?' },
      { key: 'first_phase_name', type: 'input',
        question: 'First phase name for this milestone?' },
      { key: 'create_req_prefix', type: 'confirm',
        question: 'Create a new "## <milestone> Requirements" section in REQUIREMENTS.md?' },
    ],
  };
}

function _validateAnswers(a) {
  for (const key of ['milestone_name', 'milestone_goal', 'first_phase_name']) {
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
  let next;
  const marker = '\n## Out of Scope';
  const idx = current.indexOf(marker);
  if (idx >= 0) {
    next = current.slice(0, idx) + header + current.slice(idx);
  } else {
    next = current.endsWith('\n') ? current + header : current + '\n' + header;
  }
  _writeFile(reqPath, next);
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

  const milestoneId = _slugify(answers.milestone_name);
  if (milestoneId === '') {
    throw new NubosPilotError(
      'invalid-slug',
      'milestone_name slugifies to empty string',
      { value: answers.milestone_name, field: 'milestone_name' },
    );
  }
  const firstPhaseSlug = phaseSlug(answers.first_phase_name);
  if (firstPhaseSlug === '') {
    throw new NubosPilotError(
      'invalid-slug',
      'first_phase_name slugifies to empty string',
      { value: answers.first_phase_name, field: 'first_phase_name' },
    );
  }

  

  

  

  const { phases: existingPhases } = parseRoadmap(root);
  let globalMax = 0;
  for (const p of existingPhases) {
    const n = Number(p.number);
    if (Number.isInteger(n) && n > globalMax) globalMax = n;
  }
  const nextPhaseNumber = globalMax + 1;

  

  

  

  addMilestone(
    {
      id: milestoneId,
      name: answers.milestone_name,
      phases: [
        {
          number: nextPhaseNumber,
          slug: firstPhaseSlug,
          name: answers.first_phase_name,
          goal: answers.milestone_goal,
          depends_on: [],
          requirements: [],
          success_criteria: [],
          status: 'pending',
          plans: [],
        },
      ],
    },
    root,
  );
  const phaseResult = {
    milestoneId,
    number: nextPhaseNumber,
    slug: firstPhaseSlug,
  };

  

  void addPhase;

  

  const phaseDir = createPhaseDir(phaseResult.number, firstPhaseSlug, root);
  const padded = String(phaseResult.number).padStart(2, '0');
  const ctxVars = {
    phase_number: String(phaseResult.number),
    phase_name: answers.first_phase_name,
    phase_padded: padded,
    phase_slug: firstPhaseSlug,
    created_date: new Date().toISOString().slice(0, 10),
    domain_text: '<!-- TBD: phase boundary -->',
    decisions_text: '<!-- TBD: decisions -->',
    canonical_refs_text: '<!-- TBD: canonical references -->',
    code_context_text: '<!-- TBD: existing code insights -->',
    specifics_text: '<!-- TBD: specific ideas / references -->',
    deferred_text: '<!-- TBD: deferred ideas -->',
  };
  const contextMdPath = path.join(phaseDir, padded + '-CONTEXT.md');
  _writeFile(contextMdPath, _render(_loadTemplate('CONTEXT'), ctxVars, 'CONTEXT'));

  

  if (answers.create_req_prefix === true) {
    _appendReqPrefix(root, answers.milestone_name);
  }

  

  mutateState((state) => {
    const fm = Object.assign({}, state.frontmatter, {
      milestone: milestoneId,
      milestone_name: answers.milestone_name,
      current_phase: Number(phaseResult.number),
      current_plan: null,
      current_task: null,
      last_updated: new Date().toISOString(),
    });
    return { frontmatter: fm, body: state.body };
  }, root);

  
  projectStateDir(root);

  _emit(stdout, {
    mode: 'apply',
    milestoneId,
    phaseNumber: phaseResult.number,
    phaseSlug: firstPhaseSlug,
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

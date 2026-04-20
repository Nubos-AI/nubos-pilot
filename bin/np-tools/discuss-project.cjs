const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { scan } = require('../../lib/workspace-scan.cjs');
const { workspaceGitInfo } = require('../../lib/git.cjs');
const textMode = require('../../lib/text-mode.cjs');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const REQUIRED_FIELDS = Object.freeze([
  'project_description',
  'domain_text',
  'target_users_text',
  'non_goals_text',
  'success_criteria_text',
  'strategic_decisions_text',
]);

function _render(raw, vars, name) {
  return raw.replace(PLACEHOLDER_RE, (_m, key) => {
    if (!(key in vars)) {
      throw new NubosPilotError(
        'template-unresolved-var',
        `Undefined placeholder {{${key}}} in template "${name}"`,
        { template: name, variable: key, available: Object.keys(vars) },
      );
    }
    return String(vars[key]);
  });
}

function _parseArgs(args) {
  const flags = {
    cwd: null,
    mode: 'plan',
    answersPath: null,
    bootstrap: false,
    proposedRequirementsPath: null,
  };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (a === '--cwd') flags.cwd = args[++i];
    else if (a === '--apply') { flags.mode = 'apply'; flags.answersPath = args[++i]; }
    else if (a === '--bootstrap') flags.bootstrap = true;
    else if (a === '--proposed-requirements') flags.proposedRequirementsPath = args[++i];
  }
  return flags;
}

function _scanContextFor(projectRoot) {
  const scanResult = scan({ cwd: projectRoot, batchSize: 1000, gitInfo: workspaceGitInfo });
  return {
    file_count: scanResult.stats.file_count,
    language_distribution: scanResult.language_distribution,
    manifest_paths: Object.keys(scanResult.manifests).sort(),
    doc_paths: Object.keys(scanResult.docs).sort(),
    git: scanResult.git,
    readme_head: scanResult.docs['README.md']
      ? (scanResult.docs['README.md'].content || '').split('\n').slice(0, 40).join('\n')
      : null,
  };
}

function _grayAreas() {
  return [
    {
      key: 'target_users_text',
      question: 'Target users — who uses this and in what context?',
    },
    {
      key: 'domain_text',
      question: 'Domain / lore / background — what world does this live in? (industry, inspiration, reference systems)',
    },
    {
      key: 'project_description',
      question: 'What This Is — 2–3 sentences describing what the product does and who it serves (in your words)',
    },
    {
      key: 'non_goals_text',
      question: 'Non-Goals — what is this project explicitly NOT? List things that might look in-scope but are out.',
    },
    {
      key: 'success_criteria_text',
      question: 'Success Criteria — how do you know it worked? Concrete, observable, not vibes.',
    },
    {
      key: 'strategic_decisions_text',
      question: 'Strategic Decisions — tech choices, constraints you are locking in at the product level (stack, deployment model, data strategy, etc.)',
    },
  ];
}

function _emitPlan(projectRoot, flags, stdout) {
  const projectMd = path.join(projectRoot, '.nubos-pilot', 'PROJECT.md');
  const projectExists = fs.existsSync(projectMd);
  const mode = flags.bootstrap || !projectExists ? 'bootstrap' : 'refresh';

  const scanContext = _scanContextFor(projectRoot);

  const tmDetail = textMode.resolveTextModeDetail(projectRoot);

  stdout.write(JSON.stringify({
    mode: 'plan',
    sub_mode: mode,
    project_md_exists: projectExists,
    project_md_path: projectMd,
    scan_context: scanContext,
    questions: _grayAreas(),
    required_fields: REQUIRED_FIELDS,
    requirements_md_path: path.join(projectRoot, '.nubos-pilot', 'REQUIREMENTS.md'),
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
  }, null, 2));
}

function _validateAnswers(answers) {
  for (const key of REQUIRED_FIELDS) {
    if (typeof answers[key] !== 'string' || answers[key].trim() === '') {
      throw new NubosPilotError(
        'discuss-project-missing-field',
        'answers JSON missing field: ' + key,
        { field: key },
      );
    }
  }
}

function _readExistingProjectMd(projectMd) {
  if (!fs.existsSync(projectMd)) return null;
  try {
    return fs.readFileSync(projectMd, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'discuss-project-project-unreadable',
      'PROJECT.md present but unreadable',
      { path: projectMd, cause: err && err.code },
    );
  }
}

function _extractExistingField(md, heading) {
  const re = new RegExp('^##\\s+' + heading.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*$', 'm');
  const match = md.match(re);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = md.slice(start);
  const nextHeading = rest.match(/\n##\s+/);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return body.trim();
}

function _replaceSectionBody(md, heading, newBody) {
  const lines = md.split('\n');
  const headingRe = new RegExp('^##\\s+' + heading.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*$');
  const nextHeadingRe = /^##\s+\S/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) { endIdx = i; break; }
  }
  const before = lines.slice(0, startIdx + 1);
  const after = lines.slice(endIdx);
  return [...before, '', newBody, '', ...after].join('\n');
}

function _applyRefresh(projectRoot, projectMd, answers) {
  const raw = _readExistingProjectMd(projectMd);
  if (!raw) {
    throw new NubosPilotError(
      'discuss-project-cannot-refresh',
      'cannot refresh because PROJECT.md does not exist — run np:new-project first',
      { path: projectMd },
    );
  }

  const updates = [
    { heading: 'What This Is', body: answers.project_description },
    { heading: 'Domain', body: answers.domain_text },
    { heading: 'Target Users', body: answers.target_users_text },
    { heading: 'Non-Goals', body: answers.non_goals_text },
    { heading: 'Success Criteria', body: answers.success_criteria_text },
    { heading: 'Strategic Decisions', body: answers.strategic_decisions_text },
  ];

  let out = raw;
  for (const u of updates) {
    const replaced = _replaceSectionBody(out, u.heading, u.body);
    if (replaced != null) {
      out = replaced;
    } else {
      out = out.replace(/\n## Constraints/, '\n## ' + u.heading + '\n\n' + u.body + '\n\n## Constraints');
    }
  }

  const now = new Date().toISOString().slice(0, 10);
  out = out.replace(/\*Last updated:[^\n]*\*/g, '*Last updated: ' + now + ' after np:discuss-project*');

  atomicWriteFileSync(projectMd, out);
  return { mode: 'apply-refresh', project_md_path: projectMd, updated_at: now };
}

function _applyBootstrap(projectRoot, answers) {
  const projectMd = path.join(projectRoot, '.nubos-pilot', 'PROJECT.md');
  const raw = _readExistingProjectMd(projectMd);
  if (!raw) {
    throw new NubosPilotError(
      'discuss-project-bootstrap-requires-project',
      'bootstrap mode requires PROJECT.md to exist (scaffold first via np:new-project)',
      { path: projectMd },
    );
  }
  const result = _applyRefresh(projectRoot, projectMd, answers);
  result.mode = 'apply-bootstrap';
  return result;
}

const REQ_ID_RE = /^REQ-\d{2,}$/;
const REQ_ID_IN_MD_RE = /\*\*(REQ-\d{2,})\*\*/g;

function _extractExistingReqIds(reqMd) {
  const ids = new Set();
  if (typeof reqMd !== 'string') return ids;
  let m;
  while ((m = REQ_ID_IN_MD_RE.exec(reqMd)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

function validateProposedRequirements(proposedReqs, existingIds) {
  if (!Array.isArray(proposedReqs)) {
    throw new NubosPilotError(
      'proposed-reqs-not-array',
      'proposed requirements must be a JSON array',
      { got: typeof proposedReqs },
    );
  }
  const seen = new Set();
  const valid = [];
  for (let i = 0; i < proposedReqs.length; i++) {
    const req = proposedReqs[i];
    if (!req || typeof req !== 'object') {
      throw new NubosPilotError(
        'proposed-reqs-invalid-entry',
        `entry ${i} is not an object`,
        { index: i },
      );
    }
    if (typeof req.id !== 'string' || !REQ_ID_RE.test(req.id)) {
      throw new NubosPilotError(
        'proposed-reqs-invalid-id',
        `entry ${i} has invalid id (expected REQ-NN): ${JSON.stringify(req.id)}`,
        { index: i, id: req.id },
      );
    }
    if (typeof req.text !== 'string' || req.text.trim() === '') {
      throw new NubosPilotError(
        'proposed-reqs-empty-text',
        `entry ${i} (${req.id}) has empty text`,
        { index: i, id: req.id },
      );
    }
    if (seen.has(req.id)) {
      throw new NubosPilotError(
        'proposed-reqs-duplicate-id',
        `duplicate id in proposed requirements: ${req.id}`,
        { id: req.id },
      );
    }
    if (existingIds && existingIds.has(req.id)) {
      throw new NubosPilotError(
        'proposed-reqs-collides-with-existing',
        `id already exists in REQUIREMENTS.md: ${req.id}`,
        { id: req.id },
      );
    }
    seen.add(req.id);
    valid.push({ id: req.id, text: req.text.trim() });
  }
  return valid;
}

function _applyProposedRequirements(projectRoot, proposedReqs) {
  if (!Array.isArray(proposedReqs) || proposedReqs.length === 0) return null;
  const reqMdPath = path.join(projectRoot, '.nubos-pilot', 'REQUIREMENTS.md');
  if (!fs.existsSync(reqMdPath)) return null;
  const raw = fs.readFileSync(reqMdPath, 'utf-8');
  const existingIds = _extractExistingReqIds(raw);
  const valid = validateProposedRequirements(proposedReqs, existingIds);

  const lines = [];
  lines.push('## Proposed (from np:discuss-project)');
  lines.push('');
  lines.push('_Review and promote to Active. Remove this block once reconciled._');
  lines.push('');
  for (const req of valid) {
    lines.push('- **' + req.id + '** — ' + req.text);
  }
  lines.push('');
  const appended = raw + '\n' + lines.join('\n') + '\n';
  atomicWriteFileSync(reqMdPath, appended);
  return reqMdPath;
}

function _apply(projectRoot, flags, stdout) {
  let raw;
  try {
    raw = fs.readFileSync(flags.answersPath, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'discuss-project-answers-unreadable',
      'answers file not readable: ' + flags.answersPath,
      { path: flags.answersPath, cause: err && err.code },
    );
  }
  let answers;
  try {
    answers = JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'discuss-project-answers-parse-error',
      'answers file is not valid JSON',
      { path: flags.answersPath, cause: err && err.message },
    );
  }
  _validateAnswers(answers);

  const projectMd = path.join(projectRoot, '.nubos-pilot', 'PROJECT.md');
  const shouldBootstrap = flags.bootstrap || (answers._mode === 'bootstrap');
  const result = shouldBootstrap
    ? _applyBootstrap(projectRoot, answers)
    : _applyRefresh(projectRoot, projectMd, answers);

  let reqPath = null;
  if (flags.proposedRequirementsPath) {
    try {
      const reqs = JSON.parse(fs.readFileSync(flags.proposedRequirementsPath, 'utf-8'));
      reqPath = _applyProposedRequirements(projectRoot, reqs);
    } catch (err) {
      throw new NubosPilotError(
        'discuss-project-proposed-reqs-unreadable',
        'proposed requirements file not readable/parseable: ' + flags.proposedRequirementsPath,
        { path: flags.proposedRequirementsPath, cause: err && err.message },
      );
    }
  }

  stdout.write(JSON.stringify({
    ...result,
    requirements_updated: reqPath ? path.relative(projectRoot, reqPath) : null,
  }, null, 2));
}

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const flags = _parseArgs(args);
  const projectRoot = path.resolve(flags.cwd || context.cwd || process.cwd());

  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) {
    throw new NubosPilotError(
      'discuss-project-not-initialized',
      '.nubos-pilot/ not found — run np:new-project first',
      { cwd: projectRoot },
    );
  }

  if (flags.mode === 'apply') {
    _apply(projectRoot, flags, stdout);
  } else {
    _emitPlan(projectRoot, flags, stdout);
  }
}

module.exports = { run, _parseArgs, REQUIRED_FIELDS, validateProposedRequirements };

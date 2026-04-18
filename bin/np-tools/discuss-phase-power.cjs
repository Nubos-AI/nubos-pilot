const fs = require('node:fs');
const path = require('node:path');

const {
  atomicWriteFileSync,
  withFileLock,
  NubosPilotError,
} = require('../../lib/core.cjs');
const { findPhaseDir, paddedPhase } = require('../../lib/phase.cjs');
const { loadTemplate } = require('../../lib/template.cjs');

const DEFAULT_QUESTIONS = [

  { id: 'Q-01', area: 'domain',         question: 'What is the phase boundary — what IS and what is NOT in scope?', explain: 'The phase boundary separates work that belongs in this phase from downstream phases. Narrow scope to prevent plan drift.' },
  { id: 'Q-02', area: 'domain',         question: 'What problem does this phase solve for the end user?',            explain: 'Surface the user-facing value so downstream planners remember the goal, not just the mechanism.' },

  { id: 'Q-03', area: 'decisions',      question: 'What are the main implementation decisions (D-XX style)?',        explain: 'Decisions lock architecture choices so downstream plans cannot re-litigate them. Number them D-XX for traceability.' },
  { id: 'Q-04', area: 'decisions',      question: 'Which prior-art patterns are adopted, modified, or rejected here?', explain: 'Explicit adoption/rejection prevents silent drift when the planner reads prior-art.' },

  { id: 'Q-05', area: 'canonical_refs', question: 'Which prior-phase CONTEXT.md files MUST be read before planning?', explain: 'Pointing downstream agents at the right references is cheaper than re-deriving decisions.' },
  { id: 'Q-06', area: 'canonical_refs', question: 'Which ADRs / REQUIREMENTS entries are authoritative for this phase?', explain: 'List only the ADRs and requirement IDs that actually constrain this phase, not the whole catalogue.' },

  { id: 'Q-07', area: 'code_context',   question: 'Which existing lib/*.cjs or bin/*.cjs modules are reused?',       explain: 'Reuse is mandatory where the API exists. Planner should not re-implement what Phase 2/3 already ships.' },
  { id: 'Q-08', area: 'code_context',   question: 'Which integration points / file-tree locations does this phase write to?', explain: 'File-tree boundaries matter for Git-atomic commits and parallel execution safety.' },

  { id: 'Q-09', area: 'specifics',      question: 'What user-specific expectations or workflow UX must the output honor?', explain: 'Specifics capture preferences the user confirmed in discussion and which tests will verify.' },
  { id: 'Q-10', area: 'specifics',      question: 'Are there concrete file paths, error codes, or CLI strings the user pinned?', explain: 'Pinned strings become acceptance-criterion grep targets for the plan-checker.' },

  { id: 'Q-11', area: 'deferred',       question: 'What is explicitly DEFERRED to a later phase?',                    explain: 'Deferral entries protect scope and prevent revisit-creep during execution.' },
  { id: 'Q-12', area: 'deferred',       question: 'Which ideas were actively rejected (not merely postponed)?',       explain: 'Rejected ideas with rationale help future audits understand why the surface stays small.' },
];

const AREAS = ['domain', 'decisions', 'canonical_refs', 'code_context', 'specifics', 'deferred'];

function _resolvePhaseDir(phaseArg, cwd) {
  const dir = findPhaseDir(phaseArg, cwd);
  if (!dir) {
    throw new NubosPilotError(
      'phase-not-found',
      'No phase directory for phase ' + phaseArg,
      { phase: phaseArg }
    );
  }
  return dir;
}

function _questionsPath(phaseDir, padded) {
  return path.join(phaseDir, padded + '-QUESTIONS.json');
}

function _contextPath(phaseDir, padded) {
  return path.join(phaseDir, padded + '-CONTEXT.md');
}

function _readQuestions(qpath) {
  const raw = fs.readFileSync(qpath, 'utf-8');
  return JSON.parse(raw);
}

function _writeQuestions(qpath, doc) {
  atomicWriteFileSync(qpath, JSON.stringify(doc, null, 2) + '\n');
}

function _verbInit(args, ctx) {
  const phaseArg = args[1];
  const padded = paddedPhase(phaseArg);
  const phaseDir = _resolvePhaseDir(phaseArg, ctx.cwd);
  const qpath = _questionsPath(phaseDir, padded);
  if (fs.existsSync(qpath)) {
    throw new NubosPilotError(
      'power-questions-exist',
      'QUESTIONS.json already exists for phase ' + phaseArg,
      { path: qpath }
    );
  }
  const doc = {
    phase: Number(phaseArg),
    padded,
    mode: 'power',
    created: new Date().toISOString(),
    questions: DEFAULT_QUESTIONS.map((q) => ({
      id: q.id,
      area: q.area,
      question: q.question,
      answer: null,
      explain: q.explain,
    })),
    answers_status: 'pending',
  };
  withFileLock(qpath, () => {

    if (fs.existsSync(qpath)) {
      throw new NubosPilotError(
        'power-questions-exist',
        'QUESTIONS.json already exists for phase ' + phaseArg,
        { path: qpath }
      );
    }
    _writeQuestions(qpath, doc);
  });
  const payload = {
    status: 'initialized',
    path: qpath,
    question_count: doc.questions.length,
    padded,
  };
  ctx.stdout.write(JSON.stringify(payload, null, 2));
  return payload;
}

function _computeStats(doc) {
  const areas = {};
  for (const a of AREAS) areas[a] = { total: 0, answered: 0 };
  let answered = 0;
  for (const q of doc.questions) {
    if (!areas[q.area]) areas[q.area] = { total: 0, answered: 0 };
    areas[q.area].total += 1;
    if (q.answer !== null && q.answer !== undefined && String(q.answer).trim() !== '') {
      areas[q.area].answered += 1;
      answered += 1;
    }
  }
  return {
    total_questions: doc.questions.length,
    answered,
    pending: doc.questions.length - answered,
    areas,
  };
}

function _verbRefresh(args, ctx) {
  const phaseArg = args[1];
  const padded = paddedPhase(phaseArg);
  const phaseDir = _resolvePhaseDir(phaseArg, ctx.cwd);
  const qpath = _questionsPath(phaseDir, padded);
  const doc = withFileLock(qpath, () => _readQuestions(qpath));
  const stats = _computeStats(doc);

  ctx.stdout.write(JSON.stringify(stats, null, 2));
  return stats;
}

function _groupAnswersByArea(doc) {
  const grouped = {};
  for (const a of AREAS) grouped[a] = [];
  for (const q of doc.questions) {
    if (!grouped[q.area]) grouped[q.area] = [];
    grouped[q.area].push('- **' + q.question + '** ' + String(q.answer));
  }
  const out = {};
  for (const a of AREAS) {
    out[a + '_text'] = grouped[a].length ? grouped[a].join('\n') : '_(no entries)_';
  }
  return out;
}

function _verbFinalize(args, ctx) {
  const phaseArg = args[1];
  const padded = paddedPhase(phaseArg);
  const phaseDir = _resolvePhaseDir(phaseArg, ctx.cwd);
  const qpath = _questionsPath(phaseDir, padded);

  return withFileLock(qpath, () => {
    const doc = _readQuestions(qpath);
    const pending = doc.questions
      .filter((q) => q.answer === null || q.answer === undefined || String(q.answer).trim() === '')
      .map((q) => q.id);
    if (pending.length > 0) {
      throw new NubosPilotError(
        'power-finalize-incomplete',
        'Cannot finalize: ' + pending.length + ' unanswered question(s)',
        { pending_ids: pending }
      );
    }
    const grouped = _groupAnswersByArea(doc);
    const vars = Object.assign(
      { phase: String(doc.phase), padded: doc.padded },
      grouped,
    );
    const rendered = loadTemplate('CONTEXT', vars, ctx.cwd);
    const ctxPath = _contextPath(phaseDir, padded);
    atomicWriteFileSync(ctxPath, rendered);

    doc.answers_status = 'finalized';
    _writeQuestions(qpath, doc);

    const payload = {
      status: 'finalized',
      context_path: ctxPath,
      questions_path: qpath,
    };
    ctx.stdout.write(JSON.stringify(payload, null, 2));
    return payload;
  });
}

function _verbExplain(args, ctx) {
  const phaseArg = args[1];
  const qid = args[2];
  if (!qid) {
    throw new NubosPilotError(
      'power-explain-missing-id',
      'explain verb requires a question id',
      { got: qid }
    );
  }
  const padded = paddedPhase(phaseArg);
  const phaseDir = _resolvePhaseDir(phaseArg, ctx.cwd);
  const qpath = _questionsPath(phaseDir, padded);
  const doc = _readQuestions(qpath);
  const q = doc.questions.find((x) => x.id === qid);
  if (!q) {
    throw new NubosPilotError(
      'power-question-not-found',
      'Question ' + qid + ' not found in QUESTIONS.json',
      { id: qid, path: qpath }
    );
  }
  ctx.stdout.write(JSON.stringify(q, null, 2));
  return q;
}

function _verbExit(args, ctx) {
  const phaseArg = args[1];
  const padded = paddedPhase(phaseArg);
  const phaseDir = _resolvePhaseDir(phaseArg, ctx.cwd);
  const qpath = _questionsPath(phaseDir, padded);
  const preserved = fs.existsSync(qpath);
  const payload = {
    status: 'exited',
    questions_preserved: preserved,
    path: preserved ? qpath : null,
  };
  ctx.stdout.write(JSON.stringify(payload, null, 2));
  return payload;
}

function run(args, ctx) {
  const context = {
    cwd: (ctx && ctx.cwd) || process.cwd(),
    stdout: (ctx && ctx.stdout) || process.stdout,
  };
  const verb = (args && args[0]) || '';
  switch (verb) {
    case 'init':     return _verbInit(args, context);
    case 'refresh':  return _verbRefresh(args, context);
    case 'finalize': return _verbFinalize(args, context);
    case 'explain':  return _verbExplain(args, context);
    case 'exit':     return _verbExit(args, context);
    default:
      throw new NubosPilotError(
        'power-unknown-verb',
        'Unknown verb: "' + verb + '" (expected one of init|refresh|finalize|explain|exit)',
        { got: verb }
      );
  }
}

module.exports = {
  run,
  DEFAULT_QUESTIONS,
  AREAS,
  _computeStats,
  _groupAnswersByArea,
};

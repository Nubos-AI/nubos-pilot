const fs = require('node:fs');
const path = require('node:path');
const safePath = require('../../lib/safe-path.cjs');

const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { getFlag, positionalArgs } = require('./_args.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { setTaskStatus } = require('../../lib/tasks.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const layout = require('../../lib/layout.cjs');
const git = require('../../lib/git.cjs');
const { commitTask, findCommitByTaskId } = git;
const { finishTask, readCheckpoint, mergeCheckpoint } = require('../../lib/checkpoint.cjs');

const BYPASS_FLAG = '--bypass-nubosloop';

function _assertLoopGate(taskId, cwd, bypass, stderr) {
  const cp = readCheckpoint(taskId, cwd);
  const np = (cp && cp.nubosloop) || null;
  const last = np && np.last_phase;
  const findingsObserved = np && np.findings !== undefined ? JSON.stringify(np.findings).slice(0, 60) : 'undefined';
  const checks = [
    { ok: !!cp,                              reason: 'no-checkpoint',                missing: 'checkpoint',         observed: 'no-checkpoint' },
    { ok: last === 'commit',                 reason: 'last-phase-mismatch',          missing: 'last_phase=commit',  observed: last || 'none' },
    { ok: np && np.verify_exit_code === 0,   reason: 'post-executor-not-green',      missing: 'verify_exit_code=0', observed: np && np.verify_exit_code !== undefined ? String(np.verify_exit_code) : 'undefined' },
    { ok: np && Array.isArray(np.findings),  reason: 'post-critics-missing',         missing: 'findings (array)',   observed: findingsObserved },
    { ok: np && Array.isArray(np.findings) && np.findings.length === 0,
                                             reason: 'post-critics-not-converged',   missing: 'findings=[] (zero open findings)',
                                             observed: findingsObserved },
    { ok: np && !!np.committed_at,           reason: 'commit-phase-not-stamped',     missing: 'committed_at',       observed: (np && np.committed_at) || 'undefined' },
  ];
  const failed = checks.find((c) => !c.ok);
  if (!failed) {
    return { bypassed: false, last_phase: last, forced_commit_phase: !!(np && np.forced_commit_phase) };
  }
  if (bypass) {
    stderr.write(
      '[nubos-pilot] WARNING: commit-task ' + taskId +
      ' bypassing Nubosloop gate (' + BYPASS_FLAG +
      '; reason=' + failed.reason + '; missing=' + failed.missing +
      '; observed=' + failed.observed +
      '). Single-pass commit, no critic review enforced.\n',
    );
    return { bypassed: true, last_phase: last || null, forced_commit_phase: !!(np && np.forced_commit_phase) };
  }
  throw new NubosPilotError(
    'commit-task-loop-bypass-violation',
    'commit-task refused: Nubosloop sequence incomplete for ' + taskId +
    ' (reason=' + failed.reason + '; missing=' + failed.missing +
    '; observed=' + failed.observed + '). ' +
    'Run the full loop (preflight → post-executor verify-green → post-critics → commit) first, or pass ' + BYPASS_FLAG +
    ' for an explicit single-pass override.',
    {
      taskId,
      reason: failed.reason,
      missing: failed.missing,
      observed_last_phase: last || null,
      observed_verify_exit_code: np && np.verify_exit_code !== undefined ? np.verify_exit_code : null,
      observed_findings_is_array: !!(np && Array.isArray(np.findings)),
      observed_committed_at: (np && np.committed_at) || null,
    },
  );
}

function _resolveTaskFile(taskId, cwd) {
  const parsed = layout.parseTaskFullId(taskId);
  const filePath = layout.taskPlanPath(parsed.milestone, parsed.slice, parsed.task, cwd);
  if (!fs.existsSync(filePath)) {
    throw new NubosPilotError(
      'commit-task-not-found',
      'No task file found for id ' + taskId + ' at ' + filePath,
      { taskId, path: filePath },
    );
  }
  return { filePath };
}

function _resolveSafe(root, p) {
  try {
    safePath.assertInsideBase(root, path.resolve(root, p), 'commit-files');
  } catch (err) {
    if (err && (err.code === 'safe-path-outside-base' || err.code === 'safe-path-invalid-input' || err.code === 'safe-path-base-missing')) {
      throw new NubosPilotError(
        'path-not-in-project',
        'files_modified entry escapes project root: ' + p,
        { path: p, root, cause: err.code },
      );
    }
    throw err;
  }
  return p;
}

const _COMMIT_NAME_MAX = 200;
const _COMMIT_BODY_MAX = 2000;
const _TASK_ID_PREFIX_RE = /^\s*M\d{3,}-S\d{3,}-T\d{4,}\s*[—:-]\s*/;
const _PLACEHOLDER_RE = /^\s*(?:\{\{.*\}\}|_?TBD\b.*|_none\b.*)\s*$/i;

function _sanitizeCommitName(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, _COMMIT_NAME_MAX);
}

// The scaffolded H1 is "# <task-id> — <name>"; without a `name:` frontmatter
// field the body regex captures the whole heading, producing the duplicated
// "task(ID): ID — desc" subject. Strip a leading task-id prefix so the subject
// reads "task(ID): desc".
function _extractName(frontmatter, body) {
  // Strip a leading task-id prefix, but fall through to the next source when the
  // strip empties the candidate — a `name:` of just "M001-S001-T0001 —" or an H1
  // with no description must not produce a bare "task(ID): " subject.
  if (typeof frontmatter.name === 'string' && frontmatter.name.length > 0) {
    const stripped = _sanitizeCommitName(String(frontmatter.name).replace(_TASK_ID_PREFIX_RE, ''));
    if (stripped) return stripped;
  }
  const m = String(body || '').match(/^#\s+(?:Task:\s*)?(.+?)\s*$/m);
  if (m) {
    const stripped = _sanitizeCommitName(m[1].replace(_TASK_ID_PREFIX_RE, ''));
    if (stripped) return stripped;
  }
  return _sanitizeCommitName(frontmatter.id || 'task');
}

function _innerTag(body, tag) {
  const m = String(body || '').match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  if (!m) return '';
  const inner = m[1].trim();
  // A still-unfilled placeholder may carry a Markdown bullet prefix
  // (`- _TBD — …`); test the de-bulleted form so it is recognised and omitted.
  const candidate = inner.replace(/^[-*+]\s+/, '');
  return _PLACEHOLDER_RE.test(candidate) ? '' : inner;
}

function _sanitizeCommitBody(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, _COMMIT_BODY_MAX);
}

// Compose a descriptive commit body from the task's intent so the history is
// self-explanatory months later: what the task does (<action>), what it must
// satisfy (<acceptance_criteria>), the task id, and the files it touched.
function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// Test files np-test-writer wrote this task (ADR-0023). The test-writer chooses
// their paths at runtime — the planner-authored files_modified does not list
// them — so the post-test-writer phase records them in the checkpoint. Fold them
// into the commit set so the executor-greened tests land with their production
// code instead of being silently dropped.
function _tddTestFiles(taskId, cwd, root) {
  const cp = readCheckpoint(taskId, cwd);
  const np = cp && cp.nubosloop;
  const tests = np && Array.isArray(np.tdd_tests) ? np.tdd_tests : [];
  return tests.map((p) => _resolveSafe(root, p));
}

function _composeCommitBody(body, taskId, files) {
  const action = _innerTag(body, 'action');
  const accept = _innerTag(body, 'acceptance_criteria');
  const parts = [];
  if (action) parts.push(action);
  if (accept) parts.push('Acceptance:\n' + accept);
  parts.push('Task: ' + taskId);
  if (Array.isArray(files) && files.length > 0) {
    parts.push('Files: ' + files.join(', '));
  }
  return _sanitizeCommitBody(parts.join('\n\n'));
}

function run(args, ctx) {
  const context = ctx || {};
  const list = Array.isArray(args) ? args : [];
  // --cwd targets a slice worktree, mirroring spawn-offhost. `cd` is not an
  // option for the caller: every workflow invocation uses the repo-relative
  // path .nubos-pilot/bin/np-tools.cjs, which does not resolve from inside a
  // worktree. Without this flag the commit landed on the calling branch and
  // worktree isolation was a silent no-op (P3.3). getFlag refuses a following
  // flag as the value, so `--cwd --json` cannot commit against the wrong tree.
  const cwd = getFlag(list, '--cwd') || context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const bypass = list.includes(BYPASS_FLAG);
  const positional = positionalArgs(list, ['--cwd']);
  const taskId = positional[0];

  if (!taskId) {
    throw new NubosPilotError(
      'commit-task-missing-id',
      'commit-task requires a task full-id (e.g. M001-S001-T0001)',
      {},
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'commit-task-invalid-id',
      'Invalid task id format: ' + taskId + ' (expected M<NNN>-S<NNN>-T<NNNN>)',
      { taskId },
    );
  }

  const gate = _assertLoopGate(taskId, cwd, bypass, stderr);

  const { filePath } = _resolveTaskFile(taskId, cwd);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const declared = Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [];
  let files = declared.slice();
  let filesSource = 'frontmatter';
  if (files.length === 0) {
    const cp = readCheckpoint(taskId, cwd);
    const touched = cp && Array.isArray(cp.files_touched) ? cp.files_touched : [];
    if (touched.length > 0) {
      files = touched.slice();
      filesSource = 'checkpoint';
    }
  }
  if (files.length === 0) {
    throw new NubosPilotError(
      'commit-task-no-files',
      'Task ' + taskId + ' has empty files_modified and no files_touched in checkpoint',
      { taskId },
    );
  }
  const root = findProjectRoot(cwd);
  const declaredSafe = files.map((p) => _resolveSafe(root, p));
  const safeFiles = _dedupe([...declaredSafe, ..._tddTestFiles(taskId, cwd, root)]);
  const name = _extractName(frontmatter, body);
  const message = 'task(' + taskId + '): ' + name;
  // Compose the body from the paths that will actually be committed (commitTask
  // drops gitignored entries), so `git log` never advertises a file the diff omits.
  // Forward the resolved cwd to git. It used to be used for checkpoints only,
  // while every git call silently inherited process.cwd().
  const { committable } = git.classifyCommittablePaths(safeFiles, { cwd });
  const commitBody = _composeCommitBody(body, taskId, committable);

  const result = commitTask(taskId, safeFiles, message, commitBody, { cwd });

  if (result.committed === false && result.reason === 'artifacts-gitignored') {
    try {
      mergeCheckpoint(taskId, (cur) => ({
        nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
          commit_skipped: 'artifacts-gitignored',
          files_ignored: result.files_ignored.slice(),
        }),
      }), cwd);
    } catch (err) {
      process.stderr.write('[nubos-pilot warn] checkpoint stamp failed for ' + taskId + ': ' + (err && err.message) + '\n');
    }
    try { finishTask(taskId, cwd); } catch (err) {
      process.stderr.write('[nubos-pilot warn] finishTask failed for ' + taskId + ': ' + (err && err.message) + '\n');
    }
    try { setTaskStatus(taskId, 'done', cwd); } catch (err) {
      process.stderr.write('[nubos-pilot warn] setTaskStatus failed for ' + taskId + ': ' + (err && err.message) + '\n');
    }
    const skipPayload = {
      ok: true,
      task_id: taskId,
      committed: false,
      skip_reason: 'artifacts-gitignored',
      files: safeFiles,
      files_ignored: result.files_ignored,
      files_source: filesSource,
      nubosloop_bypassed: gate.bypassed,
      nubosloop_forced_commit_phase: !!gate.forced_commit_phase,
    };
    stdout.write(JSON.stringify(skipPayload));
    return skipPayload;
  }

  const sha = findCommitByTaskId(taskId, cwd);

  try { finishTask(taskId, cwd); } catch (err) {
    process.stderr.write('[nubos-pilot warn] finishTask failed for ' + taskId + ': ' + (err && err.message) + '\n');
  }
  try { setTaskStatus(taskId, 'done', cwd); } catch (err) {
    process.stderr.write('[nubos-pilot warn] setTaskStatus failed for ' + taskId + ': ' + (err && err.message) + '\n');
  }

  const payload = {
    ok: true,
    task_id: taskId,
    committed: true,
    sha,
    files: safeFiles,
    files_committed: result.files_committed,
    files_ignored: result.files_ignored,
    files_source: filesSource,
    nubosloop_bypassed: gate.bypassed,
    nubosloop_forced_commit_phase: !!gate.forced_commit_phase,
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

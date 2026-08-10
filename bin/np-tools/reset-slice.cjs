'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../../lib/core.cjs');
const { getFlag, positionalArgs } = require('./_args.cjs');
const { TASK_ID_RE } = require('../../lib/ids.cjs');
const { readState } = require('../../lib/state.cjs');
const { restoreFiles } = require('../../lib/git.cjs');
const {
  checkpointPath,
  deleteCheckpoint,
  finishTask,
  listCheckpoints,
} = require('../../lib/checkpoint.cjs');
const layout = require('../../lib/layout.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const {
  hasSliceWorktree,
  removeSliceWorktree,
  worktreeIsolationEnabled,
} = require('../../lib/worktree.cjs');

function _resolveTaskId(explicit, cwd) {
  if (explicit) {
    if (!TASK_ID_RE.test(explicit)) {
      throw new NubosPilotError(
        'reset-slice-invalid-task-id',
        'Invalid task id: ' + explicit + ' (expected M<NNN>-S<NNN>-T<NNNN>)',
        { taskId: explicit },
      );
    }
    return explicit;
  }
  let state;
  try { state = readState(cwd); } catch (err) {
    throw new NubosPilotError(
      'reset-slice-no-state',
      'STATE.md not readable — run in a nubos-pilot project',
      { cause: err && err.code },
    );
  }
  const current = state.frontmatter && state.frontmatter.current_task;
  if (typeof current !== 'string' || !TASK_ID_RE.test(current)) {
    return null;
  }
  return current;
}

function _readTaskFiles(taskId, cwd) {
  const parsed = layout.parseTaskFullId(taskId);
  const planPath = layout.taskPlanPath(parsed.milestone, parsed.slice, parsed.task, cwd);
  if (!fs.existsSync(planPath)) return [];
  const raw = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter } = extractFrontmatter(raw);
  return Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [];
}

// Errors carry a short, basename-only cause: repo convention, and reset-slice
// payloads get pasted into issues.
function _briefCause(err) {
  if (err && typeof err.code === 'string' && err.code.length > 0) return err.code;
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  const line = (stderr || String((err && err.message) || err)).split('\n')[0];
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

function _log() {
  return require('../../lib/logger.cjs').child('reset-slice');
}

function _fail(errors, code, message, err) {
  const entry = { code, message, cause: err ? _briefCause(err) : null };
  errors.push(entry);
  _log().warn(message, { event: code, cause: entry.cause });
  return entry;
}

// `exists = false` on a throwing probe made "git blew up" indistinguishable from
// "no worktree here", and a null return made a failed removal indistinguishable
// from "nothing to remove". Both now land in the payload.
function _maybeRemoveWorktreeForTask(taskId, cwd, errors) {
  if (!worktreeIsolationEnabled(cwd)) return null;
  let parsed;
  try { parsed = layout.parseTaskFullId(taskId); } catch { return null; }
  const sliceFullId = layout.sliceFullId(parsed.milestone, parsed.slice);
  let exists = false;
  try {
    exists = hasSliceWorktree(sliceFullId, cwd);
  } catch (err) {
    _fail(errors, 'reset-slice-worktree-probe-failed',
      'could not determine whether a worktree exists for ' + sliceFullId, err);
    return null;
  }
  if (!exists) return null;
  try {
    return removeSliceWorktree(sliceFullId, cwd, { force: true });
  } catch (err) {
    _fail(errors, 'reset-slice-worktree-remove-failed',
      'worktree removal failed for ' + sliceFullId, err);
    return null;
  }
}

function run(args, ctx) {
  const context = ctx || {};
  const list = Array.isArray(args) ? args : [];
  // --cwd targets a slice worktree, mirroring commit-task/spawn-offhost. Without
  // it the plan was read from the worktree while `git restore` ran against
  // process.cwd() — the main repo — shredding uncommitted user work. getFlag
  // refuses a following flag as the value, so `--cwd --keep-worktree` cannot
  // resolve to the wrong tree.
  const cwd = getFlag(list, '--cwd') || context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;

  const keepWorktree = list.includes('--keep-worktree');
  const positional = positionalArgs(list, ['--cwd']);
  const explicit = positional[0] || null;
  const taskId = _resolveTaskId(explicit, cwd);
  const errors = [];

  if (!taskId) {
    // listCheckpoints returns absolute PATH STRINGS, not checkpoint objects.
    // Reading `.task_id` off a string yielded undefined, deleteCheckpoint threw,
    // and an empty catch swallowed it — nothing was ever deleted while the
    // payload still reported "cleared N". Derive the id like checkpoint-reconcile.
    // `catch { files = []; }` turned an EACCES on the checkpoint dir into
    // "cleared 0 orphan checkpoint(s)" — a hard failure reported as a clean sweep.
    let files = [];
    try {
      files = listCheckpoints(cwd) || [];
    } catch (err) {
      throw new NubosPilotError(
        'reset-slice-checkpoint-list-failed',
        'checkpoint directory not listable (' + _briefCause(err) + ')',
        { cause: _briefCause(err) },
      );
    }
    const deleted = [];
    const skipped = [];
    const failed = [];
    for (const file of files) {
      const orphanId = path.basename(file, '.json');
      if (!TASK_ID_RE.test(orphanId)) {
        skipped.push(orphanId);
        continue;
      }
      const existedBefore = fs.existsSync(file);
      try {
        deleteCheckpoint(orphanId, cwd);
      } catch (err) {
        // A raw fs error (e.g. a directory named <task-id>.json -> EPERM) used to
        // escape untyped and abort the sweep half-done, with no payload at all.
        _fail(errors, 'reset-slice-checkpoint-delete-failed',
          'checkpoint ' + path.basename(file) + ' not deletable', err);
        failed.push({ task_id: orphanId, cause: _briefCause(err) });
        continue;
      }
      // deleteCheckpoint swallows ENOENT and returns nothing, so "did not throw"
      // is not "unlinked". Only claim what actually left the disk.
      if (existedBefore && !fs.existsSync(file)) deleted.push(orphanId);
    }
    const payload = {
      ok: failed.length === 0,
      task_id: null,
      restored_files: [],
      deleted_checkpoints: deleted,
      skipped_checkpoints: skipped,
      failed_checkpoints: failed,
      errors,
      message: 'no current_task — cleared ' + deleted.length + ' orphan checkpoint(s)'
        + (skipped.length ? ' (' + skipped.length + ' unrecognised file(s) left in place)' : '')
        + (failed.length ? ' (' + failed.length + ' undeletable file(s) left behind)' : ''),
    };
    stdout.write(JSON.stringify(payload) + '\n');
    return payload;
  }

  const files = _readTaskFiles(taskId, cwd);
  // restored_files used to echo back the CANDIDATE list from the plan, so a
  // restore that threw still reported every file as restored. Report what the
  // operation actually returned instead (P3.1 pattern).
  let restored = [];
  if (files.length > 0) {
    try {
      restored = restoreFiles(files, cwd);
    } catch (err) {
      _fail(errors, 'reset-slice-restore-failed', 'git restore failed', err);
    }
  }

  // Same for the checkpoint: finishTask swallows ENOENT and reports nothing, so
  // "it did not throw" never meant "a file was unlinked".
  const cpPath = checkpointPath(taskId, cwd);
  const cpExisted = fs.existsSync(cpPath);
  try {
    finishTask(taskId, cwd);
  } catch (err) {
    _fail(errors, 'reset-slice-finish-failed', 'finishTask failed for ' + taskId, err);
  }
  const deletedCheckpoints = cpExisted && !fs.existsSync(cpPath) ? [taskId] : [];

  const worktreeRemoved = keepWorktree ? null : _maybeRemoveWorktreeForTask(taskId, cwd, errors);

  const ok = errors.length === 0;
  const payload = {
    ok,
    task_id: taskId,
    restored_files: restored,
    deleted_checkpoints: deletedCheckpoints,
    worktree_removed: worktreeRemoved,
    errors,
    message: ok
      ? 'in-flight task discarded; working tree restored to HEAD'
        + (worktreeRemoved ? '; worktree ' + worktreeRemoved.branch + ' removed' : '')
      : 'reset-slice incomplete — ' + errors.length + ' step(s) failed: '
        + errors.map((e) => e.code).join(', '),
  };
  stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

module.exports = { run };

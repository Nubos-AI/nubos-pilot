'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE } = require('../../lib/tasks.cjs');
const { readState, mutateState } = require('../../lib/state.cjs');
const { restoreFiles } = require('../../lib/git.cjs');
const { deleteCheckpoint, listCheckpoints } = require('../../lib/checkpoint.cjs');
const layout = require('../../lib/layout.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');

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

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];

  const explicit = list[0] && !list[0].startsWith('--') ? list[0] : null;
  const taskId = _resolveTaskId(explicit, cwd);

  if (!taskId) {
    // No in-flight task — still scrub orphan checkpoints.
    let orphans = [];
    try { orphans = listCheckpoints(cwd) || []; } catch { orphans = []; }
    for (const cp of orphans) {
      try { deleteCheckpoint(cp.task_id, cwd); } catch {}
    }
    const payload = {
      ok: true,
      task_id: null,
      restored_files: [],
      deleted_checkpoints: orphans.map((c) => c.task_id),
      message: 'no current_task — cleared ' + orphans.length + ' orphan checkpoint(s)',
    };
    stdout.write(JSON.stringify(payload));
    return payload;
  }

  // Restore the in-flight task's files from HEAD.
  const files = _readTaskFiles(taskId, cwd);
  if (files.length > 0) {
    try { restoreFiles(files); } catch (err) {
      process.stderr.write('[nubos-pilot warn] restoreFiles failed: ' + (err && err.message) + '\n');
    }
  }

  // Drop the checkpoint.
  try { deleteCheckpoint(taskId, cwd); } catch {}

  // Clear STATE.current_task.
  mutateState((state) => {
    const fm = Object.assign({}, state.frontmatter, {
      current_task: null,
      last_updated: new Date().toISOString(),
    });
    return { frontmatter: fm, body: state.body };
  }, cwd);

  const payload = {
    ok: true,
    task_id: taskId,
    restored_files: files,
    deleted_checkpoints: [taskId],
    message: 'in-flight task discarded; working tree restored to HEAD',
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

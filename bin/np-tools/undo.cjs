'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { TASK_ID_RE, setTaskStatus } = require('../../lib/tasks.cjs');
const { listTaskCommits, revertCommit } = require('../../lib/git.cjs');
const layout = require('../../lib/layout.cjs');

const PREFIX_RE = /^M\d{3,}(-S\d{3,})?$/;

function _parsePrefix(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'undo-missing-prefix',
      'undo requires a milestone number or slice full-id (e.g. "1" or "M001-S002")',
      {},
    );
  }
  const s = String(raw);
  if (/^\d+$/.test(s)) {
    return layout.mId(Number(s));
  }
  if (!PREFIX_RE.test(s)) {
    throw new NubosPilotError(
      'undo-invalid-prefix',
      'Invalid prefix: ' + s + ' (expected milestone number or M<NNN>[-S<NNN>])',
      { value: s },
    );
  }
  return s;
}

function _extractTaskId(subject) {
  const m = String(subject || '').match(/^task\(([^)]+)\):/);
  if (!m) return null;
  return TASK_ID_RE.test(m[1]) ? m[1] : null;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const prefix = _parsePrefix(list[0]);

  const commits = listTaskCommits(prefix);
  if (commits.length === 0) {
    const payload = { ok: true, prefix, reverted: [], message: 'no task commits found for prefix ' + prefix };
    stdout.write(JSON.stringify(payload));
    return payload;
  }

  // Revert newest-first so prerequisites come last.
  const reverted = [];
  for (const c of commits) {
    const taskId = _extractTaskId(c.subject);
    revertCommit(c.sha);
    if (taskId) {
      try { setTaskStatus(taskId, 'pending', cwd); } catch (err) {
        process.stderr.write('[nubos-pilot warn] setTaskStatus failed for ' + taskId + ': ' + (err && err.message) + '\n');
      }
    }
    reverted.push({ sha: c.sha, subject: c.subject, task_id: taskId });
  }

  const payload = { ok: true, prefix, reverted, count: reverted.length };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

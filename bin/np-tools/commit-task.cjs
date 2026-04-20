const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { TASK_ID_RE, setTaskStatus } = require('../../lib/tasks.cjs');
const layout = require('../../lib/layout.cjs');
const git = require('../../lib/git.cjs');
const { commitTask, findCommitByTaskId } = git;
const { deleteCheckpoint } = require('../../lib/checkpoint.cjs');

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

  
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new NubosPilotError(
      'path-not-in-project',
      'files_modified entry escapes project root: ' + p,
      { path: p, root },
    );
  }
  return p;
}

function _extractName(frontmatter, body) {
  if (typeof frontmatter.name === 'string' && frontmatter.name.length > 0) return frontmatter.name;

  const m = String(body || '').match(/^#\s+(?:Task:\s*)?(.+?)\s*$/m);
  if (m) return m[1].trim();
  return frontmatter.id || 'task';
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const taskId = list[0];

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

  const { filePath } = _resolveTaskFile(taskId, cwd);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const files = Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [];
  if (files.length === 0) {
    throw new NubosPilotError(
      'commit-task-no-files',
      'Task ' + taskId + ' has empty files_modified',
      { taskId },
    );
  }
  const root = findProjectRoot(cwd);
  const safeFiles = files.map((p) => _resolveSafe(root, p));
  const name = _extractName(frontmatter, body);
  const message = 'task(' + taskId + '): ' + name;

  

  commitTask(taskId, safeFiles, message);
  const sha = findCommitByTaskId(taskId);

  try { deleteCheckpoint(taskId, cwd); } catch {  }
  try { setTaskStatus(taskId, 'done', cwd); } catch (err) {
    process.stderr.write('[nubos-pilot warn] setTaskStatus failed for ' + taskId + ': ' + (err && err.message) + '\n');
  }

  const payload = { ok: true, task_id: taskId, sha, files: safeFiles };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

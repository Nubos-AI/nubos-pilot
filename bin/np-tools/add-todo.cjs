const fs = require('node:fs');
const path = require('node:path');

const { projectStateDir, NubosPilotError } = require('../../lib/core.cjs');
const { slugify } = require('../../lib/layout.cjs');

const MAX_DESCRIPTION_LENGTH = 500;

function _buildPayload(description, cwd) {
  if (description == null || typeof description !== 'string' || !description.trim()) {
    throw new NubosPilotError(
      'add-todo-missing-description',
      'add-todo requires a non-empty description argument',
      { description: description == null ? '' : String(description) },
    );
  }
  if (/\n\n---\n/.test(description)) {
    throw new NubosPilotError(
      'add-todo-invalid-description',
      'add-todo description must not contain YAML separator pattern',
      { description },
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new NubosPilotError(
      'add-todo-description-too-long',
      'add-todo description must be <= ' + MAX_DESCRIPTION_LENGTH + ' chars',
      { length: description.length },
    );
  }
  const stateDir = projectStateDir(cwd);
  const todosDir = path.join(stateDir, 'todos');
  const pendingDir = path.join(todosDir, 'pending');
  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const slug = slugify(description);
  if (!slug) {
    throw new NubosPilotError(
      'add-todo-empty-slug',
      'add-todo description contains no slug-safe characters: ' + description,
      { description },
    );
  }
  let todo_count = 0;
  try {
    if (fs.existsSync(pendingDir)) {
      todo_count = fs
        .readdirSync(pendingDir)
        .filter((f) => f.endsWith('.md')).length;
    }
  } catch (_err) {
    todo_count = 0;
  }
  const todos_dir_exists = fs.existsSync(todosDir);
  const state_path = path.join(stateDir, 'STATE.md');
  return {
    _workflow: 'add-todo',
    commit_docs: true,
    description,
    slug,
    date,
    timestamp: iso,
    state_dir: stateDir,
    pending_dir: pendingDir,
    todos_dir_exists,
    todo_count,
    state_path,
    todos: [],
  };
}

function _emitError(err, stderr) {
  if (err && err.name === 'NubosPilotError') {
    stderr.write(
      JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n',
    );
  } else {
    stderr.write(String((err && err.stack) || err) + '\n');
  }
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const description = args.join(' ').trim();
  if (!description) {
    stderr.write('Usage: np-tools.cjs init add-todo <description>\n');
    return 1;
  }
  try {
    const payload = _buildPayload(description, cwd);
    stdout.write(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _buildPayload };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

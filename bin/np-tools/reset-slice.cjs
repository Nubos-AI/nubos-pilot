const { resetSlice } = require('../../lib/undo.cjs');

function run(_args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const result = resetSlice(cwd);
  const payload = {
    ok: true,
    task_id: result.task_id,
    restored_paths: result.restored_paths,
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

const { mutateState } = require('../../lib/state.cjs');

function run(_args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const next = mutateState((s) => {
    s.frontmatter.session = s.frontmatter.session || {};
    s.frontmatter.session.stopped_at = new Date().toISOString();
    s.frontmatter.session.resume_file = s.frontmatter.current_task
      ? '.nubos-pilot/checkpoints/' + s.frontmatter.current_task + '.json'
      : null;
    return s;
  }, cwd);
  const payload = {
    ok: true,
    stopped_at: next.frontmatter.session.stopped_at,
    resume_file: next.frontmatter.session.resume_file,
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

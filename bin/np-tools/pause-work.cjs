const { execFileSync } = require('node:child_process');

const { mutateState } = require('../../lib/state.cjs');
const { captureSnapshot, writeSnapshot } = require('../../lib/session-snapshot.cjs');

function _gitCommits(cwd, limit) {
  try {
    const out = execFileSync('git', [
      '-C', cwd,
      'log',
      '--no-color',
      '--max-count=' + Number(limit),
      '--pretty=format:%H%x09%s%x09%cI',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, subject, iso] = line.split('\t');
      return { sha, subject, committed_at: iso };
    });
  } catch {
    return [];
  }
}

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
  let snapshotPath = null;
  let snapshotErr = null;
  try {
    const snap = captureSnapshot(cwd, { lastCommits: _gitCommits(cwd, 10) });
    snapshotPath = writeSnapshot(snap, cwd);
  } catch (err) {
    snapshotErr = String((err && err.message) || err);
  }
  const payload = {
    ok: true,
    stopped_at: next.frontmatter.session.stopped_at,
    resume_file: next.frontmatter.session.resume_file,
    snapshot_path: snapshotPath,
    snapshot_error: snapshotErr,
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };

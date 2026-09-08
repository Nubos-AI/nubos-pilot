'use strict';

const { execFileSync } = require('node:child_process');

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

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const snap = captureSnapshot(cwd, { lastCommits: _gitCommits(cwd, 10) });
  const dest = writeSnapshot(snap, cwd);
  stdout.write(JSON.stringify({
    ok: true,
    snapshot_path: dest,
    captured_at: snap.captured_at,
    milestone: snap.milestone,
    current_task: snap.current_task,
    last_commit_count: snap.last_commits.length,
    open_handoff_count: snap.open_handoffs.length,
    checkpoint_count: snap.checkpoint_ids.length,
  }));
  return 0;
}

module.exports = { run };

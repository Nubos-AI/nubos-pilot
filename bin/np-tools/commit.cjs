const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { NubosPilotError } = require('../../lib/core.cjs');
const { assertCommittablePaths } = require('../../lib/git.cjs');
const { resolveCommitArtifacts } = require('../../lib/commit-policy.cjs');

const MAX_MSG = 2000;

function _usage() {
  return 'Usage:\n  np-tools.cjs commit "message" --files f1 f2 ...';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'commit-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function _parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  let msg = null;
  const files = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--files') {
      i += 1;
      while (i < args.length && !String(args[i]).startsWith('--')) {
        files.push(args[i]);
        i += 1;
      }
      continue;
    }
    if (a === '-m' || a === '--message') {
      msg = args[i + 1];
      i += 2;
      continue;
    }
    if (msg == null && !String(a).startsWith('--')) {
      msg = a;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { msg, files };
}

function _validateFiles(files) {
  for (const f of files) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new NubosPilotError('commit-invalid-path', 'commit path must be non-empty string', { path: f });
    }
    const segments = String(f).split(/[/\\]/);
    for (const seg of segments) {
      if (seg === '..') {
        throw new NubosPilotError('commit-path-traversal', 'commit path must not contain ".." segments', { path: f });
      }
    }
    if (path.isAbsolute(f)) {
      throw new NubosPilotError('commit-path-absolute', 'commit path must be relative', { path: f });
    }
  }
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  try {
    const { msg, files } = _parseArgs(argv);
    if (!msg || typeof msg !== 'string' || msg.trim() === '') {
      stderr.write(_usage() + '\n');
      return 1;
    }
    if (msg.length > MAX_MSG) {
      throw new NubosPilotError('commit-message-too-long', 'commit message exceeds ' + MAX_MSG + ' chars', { length: msg.length });
    }
    if (!Array.isArray(files) || files.length === 0) {
      stderr.write(_usage() + '\n');
      return 1;
    }
    _validateFiles(files);
    if (resolveCommitArtifacts(cwd) === false) {
      stdout.write(JSON.stringify({ committed: false, reason: 'commit_artifacts=false', files }) + '\n');
      return 0;
    }
    const committable = assertCommittablePaths(files);
    if (committable.length === 0) {
      throw new NubosPilotError('commit-no-paths', 'commit invoked with no committable paths', { files });
    }
    execFileSync('git', ['add', '--', ...committable], { stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', msg, '--', ...committable], { stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
    stdout.write(JSON.stringify({ committed: true, sha, files: committable }) + '\n');
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _parseArgs, _validateFiles };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NubosPilotError, withFileLock } = require('./core.cjs');
const { TASK_ID_RE } = require('./ids.cjs');

const GIT_TIMEOUT_MS = 30000;
const GIT_COMMIT_LOCK_TIMEOUT_MS = 90000;

function _commitLockPath(cwd) {
  return path.join(cwd || process.cwd(), '.nubos-pilot', '.git-commit');
}

let _gitLog;
function _log() {
  if (!_gitLog) _gitLog = require('./logger.cjs').child('git');
  return _gitLog;
}

function isPathIgnored(p, opts) {
  const spawnOpts = _gitOpts(opts && opts.cwd);
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', p], spawnOpts);
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    throw err;
  }
}

function classifyCommittablePaths(paths, opts) {
  if (!Array.isArray(paths)) {
    throw new NubosPilotError(
      'commit-paths-invalid',
      'classifyCommittablePaths expects an array of paths',
      { got: typeof paths },
    );
  }
  const spawnOpts = _gitOpts(opts && opts.cwd);
  const ignored = [];
  for (const p of paths) {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--', p], spawnOpts);
      ignored.push(p);
    } catch (err) {
      if (err && err.status === 128) throw err;
    }
  }
  const ignoredSet = new Set(ignored);
  const committable = paths.filter((p) => !ignoredSet.has(p));
  return { committable, ignored };
}

function assertCommittablePaths(paths, opts) {
  const { committable, ignored } = classifyCommittablePaths(paths, opts);
  if (ignored.length > 0 && committable.length > 0) {
    _log().warn('gitignored paths skipped during commit', {
      event: 'git-ignored-skipped',
      count: ignored.length,
      sample: ignored.slice(0, 5),
    });
  }
  return committable;
}

const ISSUE_CLOSING_KEYWORDS = Object.freeze([
  'close', 'closes', 'closed',
  'fix', 'fixes', 'fixed',
  'resolve', 'resolves', 'resolved',
  'implement', 'implements', 'implemented',
]);

const ISSUE_CLOSING_RE = new RegExp(
  '\\b(' + ISSUE_CLOSING_KEYWORDS.join('|') + ')\\b\\s*:?\\s+(?:(?:[\\w.-]+\\/[\\w.-]+)?#\\d+|https?:\\/\\/\\S*\\/issues\\/\\d+)',
  'i',
);

function findIssueClosingKeyword(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(ISSUE_CLOSING_RE);
  return m ? m[0] : null;
}

function assertNoIssueClosingKeywords(message, body) {
  for (const [field, text] of [['message', message], ['body', body]]) {
    const hit = findIssueClosingKeyword(text);
    if (!hit) continue;
    throw new NubosPilotError(
      'commit-issue-closing-keyword',
      'commit ' + field + ' contains the issue-closing reference "' + hit.trim() + '"',
      {
        field,
        match: hit.trim(),
        hint: 'GitHub/GitLab auto-close the issue on push and board automation moves it to Done '
          + 'before a human has tested anything. Reference the issue without closing it: use '
          + '"Refs #N" (or "See #N") and let a person close it after verification.',
      },
    );
  }
}

function commitTask(taskId, files, message, body, opts) {
  const cwd = (opts && opts.cwd) || null;
  const spawnOpts = _gitOpts(cwd);
  const { committable, ignored } = classifyCommittablePaths(files, cwd ? { cwd } : undefined);
  if (committable.length === 0) {
    if (ignored.length > 0) {
      return {
        committed: false,
        reason: 'artifacts-gitignored',
        files_committed: [],
        files_ignored: ignored.slice(),
      };
    }
    throw new NubosPilotError(
      'commit-no-paths',
      'commitTask invoked with empty file list',
      { taskId },
    );
  }
  if (ignored.length > 0) {
    _log().warn('gitignored paths skipped during commit', {
      event: 'git-ignored-skipped',
      task_id: taskId,
      count: ignored.length,
      sample: ignored.slice(0, 5),
    });
  }
  assertNoIssueClosingKeywords(message, body);
  const commitArgs = ['commit', '-m', message];
  if (typeof body === 'string' && body.trim().length > 0) {
    commitArgs.push('-m', body);
  }
  return withFileLock(_commitLockPath(cwd), () => {
    execFileSync('git', ['add', '--', ...committable], spawnOpts);
    execFileSync('git', [...commitArgs, '--', ...committable], spawnOpts);
    return {
      committed: true,
      files_committed: committable.slice(),
      files_ignored: ignored.slice(),
    };
  }, { timeoutMs: GIT_COMMIT_LOCK_TIMEOUT_MS });
}

function findCommitByTaskId(id, cwd) {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    throw new NubosPilotError(
      'task-commit-not-found',
      `Invalid task id ${id}`,
      { id },
    );
  }

  const spawnOpts = _gitOpts(cwd, { encoding: 'utf-8' });
  const out = execFileSync(
    'git',
    [
      'log',
      '--all',
      '--grep',
      `^task(${id}):`,
      '-n',
      '1',
      '--format=%H',
    ],
    spawnOpts,
  ).trim();
  if (!out) {
    throw new NubosPilotError(
      'task-commit-not-found',
      `No commit found for task ${id}`,
      { id },
    );
  }
  return out;
}

function _gitOpts(cwd, extra) {
  const o = Object.assign({ timeout: GIT_TIMEOUT_MS }, extra || {});
  if (o.stdio === undefined) o.stdio = 'pipe';
  if (cwd) o.cwd = cwd;
  return o;
}

function revertCommit(sha, cwd) {
  execFileSync('git', ['revert', '--no-edit', sha], _gitOpts(cwd));
}

function restoreFiles(paths, cwd) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  execFileSync('git', ['restore', '--', ...paths], _gitOpts(cwd));
  return paths.slice();
}

function listTaskCommits(prefix, cwd) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new NubosPilotError(
      'list-task-commits-invalid',
      'listTaskCommits requires a non-empty phase or plan id prefix',
      { prefix },
    );
  }
  const raw = execFileSync(
    'git',
    [
      'log',
      '--all',
      '--grep',
      `^task(${prefix}-`,
      '--format=%H %s',
    ],
    _gitOpts(cwd, { encoding: 'utf-8' }),
  );
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line) => {
    const sp = line.indexOf(' ');
    if (sp < 0) return { sha: line, subject: '' };
    return { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
  });
}

function gitShowSafe(ref, filepath, cwd) {
  require('./safe-path.cjs').assertSafeGitRef(ref, 'git-show-ref');
  try {
    return execFileSync(
      'git',
      ['show', ref + ':' + filepath],
      _gitOpts(cwd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (err) {
    if (err && err.status === 128) return null;
    const stderr = String(err && err.stderr || '');
    if (stderr.includes('exists on disk, but not in') || stderr.includes('does not exist in')) {
      return null;
    }
    throw err;
  }
}

function gitDiffNoColor(ref, filepath, cwd) {
  require('./safe-path.cjs').assertSafeGitRef(ref, 'git-diff-ref');
  try {
    return execFileSync(
      'git',
      ['--no-pager', 'diff', '--no-color', '--end-of-options', ref, '--', filepath],
      _gitOpts(cwd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (err) {
    if (err && typeof err.stdout === 'string') return err.stdout;
    if (err && err.stdout !== undefined) return String(err.stdout);
    throw err;
  }
}

function workspaceGitInfo(cwd) {
  const exec = (args) => {
    try {
      return execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();
    } catch {
      return null;
    }
  };

  const isRepoProbe = exec(['rev-parse', '--is-inside-work-tree']);
  if (isRepoProbe !== 'true') return { is_repo: false };

  const current_branch = exec(['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const remote = exec(['config', '--get', 'remote.origin.url']) || null;
  const branchesRaw = exec(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']) || '';
  const branches = branchesRaw.split('\n').filter(Boolean);
  const commitsRaw = exec(['log', '--pretty=format:%h|%an|%ad|%s', '--date=short', '-n', '20']) || '';
  const commits = commitsRaw.split('\n').filter(Boolean).map((line) => {
    const idx1 = line.indexOf('|');
    const idx2 = line.indexOf('|', idx1 + 1);
    const idx3 = line.indexOf('|', idx2 + 1);
    if (idx1 < 0 || idx2 < 0 || idx3 < 0) return { raw: line };
    return {
      sha: line.slice(0, idx1),
      author: line.slice(idx1 + 1, idx2),
      date: line.slice(idx2 + 1, idx3),
      subject: line.slice(idx3 + 1),
    };
  });
  return { is_repo: true, current_branch, remote, branches, commits };
}

function runGit(args, opts) {
  const o = opts || {};
  const spawnOpts = { stdio: o.stdio || ['ignore', 'pipe', 'pipe'], timeout: o.timeout || GIT_TIMEOUT_MS };
  if (o.cwd) spawnOpts.cwd = o.cwd;
  try {
    const stdout = execFileSync('git', args, spawnOpts);
    return { stdout: stdout ? stdout.toString('utf-8') : '', ok: true };
  } catch (err) {
    const stderr = (err && err.stderr) ? err.stderr.toString('utf-8') : '';
    const stdout = (err && err.stdout) ? err.stdout.toString('utf-8') : '';
    return {
      stdout,
      stderr,
      status: err && typeof err.status === 'number' ? err.status : null,
      ok: false,
      error: err,
    };
  }
}

module.exports = {
  commitTask,
  ISSUE_CLOSING_KEYWORDS,
  findIssueClosingKeyword,
  assertNoIssueClosingKeywords,
  assertCommittablePaths,
  classifyCommittablePaths,
  revertCommit,
  restoreFiles,
  findCommitByTaskId,
  isPathIgnored,
  listTaskCommits,
  gitShowSafe,
  gitDiffNoColor,
  workspaceGitInfo,
  runGit,
};

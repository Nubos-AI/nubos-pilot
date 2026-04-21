const { execFileSync } = require('node:child_process');
const { NubosPilotError } = require('./core.cjs');
const { TASK_ID_RE } = require('./tasks.cjs');

function _isFatalCheckIgnore(err) {

  
  return err && err.status !== 1;
}

function isPathIgnored(p, opts) {
  const spawnOpts = { stdio: 'pipe' };
  if (opts && opts.cwd) spawnOpts.cwd = opts.cwd;
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', p], spawnOpts);
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    if (err && err.status === 128) {

      throw err;
    }
    throw err;
  }
}

function assertCommittablePaths(paths, opts) {
  if (!Array.isArray(paths)) {
    throw new NubosPilotError(
      'commit-paths-invalid',
      'assertCommittablePaths expects an array of paths',
      { got: typeof paths },
    );
  }
  const spawnOpts = { stdio: 'pipe' };
  if (opts && opts.cwd) spawnOpts.cwd = opts.cwd;
  const ignored = [];
  for (const p of paths) {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--', p], spawnOpts);
      ignored.push(p);
    } catch (err) {
      if (_isFatalCheckIgnore(err)) {
        if (err.status === 128) throw err;

      }
    }
  }
  if (ignored.length > 0 && ignored.length === paths.length) {

    throw new NubosPilotError(
      'commit-all-paths-gitignored',
      `All target paths are gitignored: ${paths.join(', ')}`,
      { paths },
    );
  }
  if (ignored.length > 0) {

    process.stderr.write(
      `[nubos-pilot warn] gitignored (skipping): ${ignored.join(', ')}\n`,
    );
  }
  return paths.filter((p) => !ignored.includes(p));
}

function commitTask(taskId, files, message) {
  const committable = assertCommittablePaths(files);
  if (committable.length === 0) {

    

    throw new NubosPilotError(
      'commit-no-paths',
      'commitTask invoked with empty file list',
      { taskId },
    );
  }
  execFileSync('git', ['add', '--', ...committable], { stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message, '--', ...committable], { stdio: 'pipe' });
}

function findCommitByTaskId(id) {

  

  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    throw new NubosPilotError(
      'task-commit-not-found',
      `Invalid task id ${id}`,
      { id },
    );
  }

  

  
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
    { encoding: 'utf-8' },
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

function revertCommit(sha) {

  

  execFileSync('git', ['revert', '--no-edit', sha], { stdio: 'pipe' });
}

function restoreFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  execFileSync('git', ['restore', '--', ...paths], { stdio: 'pipe' });
}

function checkoutFromHead(paths, opts) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const cwd = opts && opts.cwd;
  const args = cwd ? ['-C', cwd, 'checkout', 'HEAD', '--', ...paths]
                   : ['checkout', 'HEAD', '--', ...paths];
  execFileSync('git', args, { stdio: 'pipe' });
}

function listTaskCommits(prefix) {

  
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
    { encoding: 'utf-8' },
  );
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line) => {
    const sp = line.indexOf(' ');
    if (sp < 0) return { sha: line, subject: '' };
    return { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
  });
}

function gitShowSafe(ref, filepath) {
  try {
    return execFileSync(
      'git',
      ['show', ref + ':' + filepath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
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

function gitDiffNoColor(ref, filepath) {
  try {
    return execFileSync(
      'git',
      ['--no-pager', 'diff', '--no-color', ref, '--', filepath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
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

module.exports = {
  commitTask,
  assertCommittablePaths,
  revertCommit,
  restoreFiles,
  checkoutFromHead,
  findCommitByTaskId,
  isPathIgnored,
  listTaskCommits,
  gitShowSafe,
  gitDiffNoColor,
  workspaceGitInfo,
};

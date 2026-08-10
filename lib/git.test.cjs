const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const git = require('./git.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });

  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos-pilot.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);

  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], {
    stdio: 'pipe',
  });
  _repos.push(root);
  return root;
}

function inRepo(root, fn) {
  const prev = process.cwd();
  process.chdir(root);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function writeFile(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body == null ? '' : body, 'utf-8');
  return rel;
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('GIT-1: assertCommittablePaths returns paths unchanged when none ignored', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    writeFile(root, 'b.ts', 'y');
    const out = git.assertCommittablePaths(['a.ts', 'b.ts']);
    assert.deepEqual(out, ['a.ts', 'b.ts']);
  });
});

test('GIT-2: assertCommittablePaths writes stderr warning for partial-ignored and skips ignored entries', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', 'build/\n');
    writeFile(root, 'a.ts', 'x');
    writeFile(root, 'build/out.js', 'noise');

    const original = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    let result;
    try {
      result = git.assertCommittablePaths(['a.ts', 'build/out.js']);
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(result, ['a.ts']);
    const lines = captured.split('\n').filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const gitWarn = events.find((e) => e.event === 'git-ignored-skipped');
    assert.ok(gitWarn, 'expected structured git-ignored-skipped event in stderr; got: ' + captured);
    assert.ok(gitWarn.sample.some((s) => s.includes('build/out.js')));
  });
});

test('GIT-3: assertCommittablePaths SOFT-SKIPS when every path ignored (returns [], no throw, no stderr noise)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', '.env\nsecret.txt\n');
    writeFile(root, '.env', 'X=1');
    writeFile(root, 'secret.txt', 'shh');
    const original = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    let result;
    try {
      result = git.assertCommittablePaths(['.env', 'secret.txt']);
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(result, []);
    assert.equal(captured, '', 'all-ignored is a routing signal, not a warning — caller surfaces the skip reason');
  });
});

test('GIT-3b: classifyCommittablePaths returns clean { committable, ignored } split without side effects', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', 'build/\n.env\n');
    writeFile(root, 'src/a.ts', 'x');
    writeFile(root, 'src/b.ts', 'y');
    writeFile(root, 'build/out.js', 'noise');
    writeFile(root, '.env', 'X=1');
    const original = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    let res;
    try {
      res = git.classifyCommittablePaths(['src/a.ts', 'build/out.js', 'src/b.ts', '.env']);
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(res.committable, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(res.ignored.sort(), ['.env', 'build/out.js']);
    assert.equal(captured, '', 'classify is pure introspection — no stderr writes');
  });
});

test('GIT-3c: commitTask returns soft-skip payload when every path is gitignored (no commit created)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', 'build/\n');
    writeFile(root, 'build/out.js', 'noise');
    const before = execFileSync('git', ['log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length;
    const result = git.commitTask('M006-S001-T0099', ['build/out.js'], 'task(M006-S001-T0099): doc update');
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'artifacts-gitignored');
    assert.deepEqual(result.files_committed, []);
    assert.deepEqual(result.files_ignored, ['build/out.js']);
    const after = execFileSync('git', ['log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length;
    assert.equal(after, before, 'no new commit for soft-skip');
  });
});

test('GIT-3d: commitTask commits the tracked subset on mixed paths (warns about ignored entries)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', 'build/\n');
    writeFile(root, 'src/a.ts', 'x');
    writeFile(root, 'build/out.js', 'noise');
    const original = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    let result;
    try {
      result = git.commitTask('M006-S001-T0100', ['src/a.ts', 'build/out.js'], 'task(M006-S001-T0100): mixed');
    } finally {
      process.stderr.write = original;
    }
    assert.equal(result.committed, true);
    assert.deepEqual(result.files_committed, ['src/a.ts']);
    assert.deepEqual(result.files_ignored, ['build/out.js']);
    const lines = captured.split('\n').filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const gitWarn = events.find((e) => e.event === 'git-ignored-skipped');
    assert.ok(gitWarn, 'expected structured git-ignored-skipped event; got: ' + captured);
    assert.equal(gitWarn.task_id, 'M006-S001-T0100');
    const subject = execFileSync('git', ['log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
    assert.equal(subject, 'task(M006-S001-T0100): mixed');
    const stat = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { encoding: 'utf-8' });
    assert.match(stat, /src\/a\.ts/);
    assert.doesNotMatch(stat, /build\/out\.js/);
  });
});

test('GIT-4: isPathIgnored returns true for ignored, false for tracked-eligible', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', 'node_modules/\n');
    writeFile(root, 'node_modules/x.js', '');
    writeFile(root, 'src.ts', '');
    assert.equal(git.isPathIgnored('node_modules/x.js'), true);
    assert.equal(git.isPathIgnored('src.ts'), false);
  });
});

test('GIT-5: commitTask creates a single commit containing exactly the supplied paths', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'lib/git.cjs', '// stub');
    git.commitTask('M006-S001-T0001', ['lib/git.cjs'], 'task(M006-S001-T0001): add git helper');
    const log = execFileSync('git', ['log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
    assert.equal(log, 'task(M006-S001-T0001): add git helper');
    const stat = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { encoding: 'utf-8' });
    assert.match(stat, /lib\/git\.cjs/);
  });
});

test('GIT-5b: commitTask attaches a multi-line body via a second -m when body is supplied', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'lib/git.cjs', '// stub');
    git.commitTask(
      'M006-S001-T0001',
      ['lib/git.cjs'],
      'task(M006-S001-T0001): add git helper',
      'Implements the git helper.\n\nTask: M006-S001-T0001',
    );
    const subject = execFileSync('git', ['log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
    const fullBody = execFileSync('git', ['log', '-n', '1', '--format=%b'], { encoding: 'utf-8' });
    assert.equal(subject, 'task(M006-S001-T0001): add git helper');
    assert.match(fullBody, /Implements the git helper\./);
    assert.match(fullBody, /Task: M006-S001-T0001/);
  });
});

test('GIT-5c: commitTask omits the body -m when body is empty/whitespace (backward-compatible)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'lib/git.cjs', '// stub');
    git.commitTask('M006-S001-T0001', ['lib/git.cjs'], 'task(M006-S001-T0001): add git helper', '   ');
    const fullBody = execFileSync('git', ['log', '-n', '1', '--format=%b'], { encoding: 'utf-8' }).trim();
    assert.equal(fullBody, '');
  });
});

test('GIT-6: findCommitByTaskId returns 40-char SHA for known task commit', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('M006-S001-T0001', ['a.ts'], 'task(M006-S001-T0001): add a.ts');
    const sha = git.findCommitByTaskId('M006-S001-T0001');
    assert.match(sha, /^[0-9a-f]{40}$/);
  });
});

test('GIT-7: findCommitByTaskId throws task-commit-not-found when no commit matches', () => {
  const root = makeRepo();
  inRepo(root, () => {
    assert.throws(
      () => git.findCommitByTaskId('M006-S001-T0099'),
      (err) => err.code === 'task-commit-not-found' && err.details.id === 'M006-S001-T0099',
    );
  });
});

test('GIT-8: findCommitByTaskId rejects malformed task-id BEFORE --grep embedding (regex injection guard)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    assert.throws(
      () => git.findCommitByTaskId('invalid-id'),
      (err) => err.code === 'task-commit-not-found',
    );
    assert.throws(
      () => git.findCommitByTaskId('M006-S001-T0001.*'),
      (err) => err.code === 'task-commit-not-found',
    );
  });
});

test('GIT-9: findCommitByTaskId is anchored — body-mention of stale task-id does not produce false match (Pitfall 3)', () => {
  const root = makeRepo();
  inRepo(root, () => {

    writeFile(root, 'a.ts', 'x');
    git.commitTask('M006-S001-T0001', ['a.ts'], 'task(M006-S001-T0001): real task');
    const realSha = git.findCommitByTaskId('M006-S001-T0001');

    writeFile(root, 'b.ts', 'y');
    execFileSync('git', ['add', '--', 'b.ts']);
    execFileSync('git', [
      'commit',
      '-m',
      'task(M006-S001-T0002): something',
      '-m',
      'See also task(M006-S001-T0001) which we extended here.',
    ]);

    const t1 = git.findCommitByTaskId('M006-S001-T0001');
    const t2 = git.findCommitByTaskId('M006-S001-T0002');
    assert.equal(t1, realSha, 'T01 must still resolve to the original commit, not the body-mention');
    assert.notEqual(t1, t2);
  });
});

test('GIT-10: revertCommit creates a forward revert commit (no history rewrite)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('M006-S001-T0001', ['a.ts'], 'task(M006-S001-T0001): add a.ts');
    const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim();
    const sha = git.findCommitByTaskId('M006-S001-T0001');
    git.revertCommit(sha);
    const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim();
    assert.equal(Number(after), Number(before) + 1, 'revert must add a new commit, not rewrite history');

    const stillThere = execFileSync('git', ['cat-file', '-t', sha], { encoding: 'utf-8' }).trim();
    assert.equal(stillThere, 'commit');
  });
});

test('GIT-11: restoreFiles resets working-tree changes for the given paths', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'original');
    git.commitTask('M006-S001-T0001', ['a.ts'], 'task(M006-S001-T0001): add a.ts');
    fs.writeFileSync(path.join(root, 'a.ts'), 'mutated', 'utf-8');
    git.restoreFiles(['a.ts']);
    const content = fs.readFileSync(path.join(root, 'a.ts'), 'utf-8');
    assert.equal(content, 'original');
  });
});

test('GIT-12: listTaskCommits returns parsed array of {sha, subject} for a slice-id prefix', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('M006-S001-T0001', ['a.ts'], 'task(M006-S001-T0001): first');
    writeFile(root, 'b.ts', 'y');
    git.commitTask('M006-S001-T0002', ['b.ts'], 'task(M006-S001-T0002): second');
    const list = git.listTaskCommits('M006-S001');
    assert.equal(list.length, 2);
    for (const entry of list) {
      assert.match(entry.sha, /^[0-9a-f]{40}$/);
      assert.match(entry.subject, /^task\(M006-S001-T000[12]\):/);
    }
  });
});

function commitFile(root, rel, body, msg) {
  writeFile(root, rel, body);
  execFileSync('git', ['-C', root, 'add', '--', rel], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', msg], { stdio: 'pipe' });
}

test('GIT-SHOW-1: gitShowSafe returns file body for committed path', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'README.md', 'hello world\n', 'chore: add README');
    const body = git.gitShowSafe('HEAD', 'README.md');
    assert.equal(body, 'hello world\n');
  });
});

test('GIT-SHOW-2: gitShowSafe returns null for non-existent path (Pitfall 5 exit-128)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'README.md', 'x\n', 'chore: seed');
    const body = git.gitShowSafe('HEAD', 'no-such-file.md');
    assert.equal(body, null);
  });
});

test('GIT-SHOW-3: gitShowSafe returns null for path not yet in HEAD (uncommitted rename case)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'a.md', 'alpha\n', 'chore: seed');
    const body = git.gitShowSafe('HEAD', '.planning/phases/09-feature-set/09-01-PLAN.md');
    assert.equal(body, null);
  });
});

test('GIT-SHOW-4: gitShowSafe returns null for git-repo-missing case (pragmatic extension of Pitfall 5 semantics)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-git-noregion-'));
  const prev = process.cwd();
  process.chdir(tmp);
  try {
    assert.equal(git.gitShowSafe('HEAD', 'any.md'), null);
  } finally {
    process.chdir(prev);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('GIT-DIFF-1: gitDiffNoColor returns diff body starting with "diff --git" after mutation', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'README.md', 'original\n', 'chore: seed');
    fs.writeFileSync(path.join(root, 'README.md'), 'modified\n', 'utf-8');
    const diff = git.gitDiffNoColor('HEAD', 'README.md');
    assert.ok(diff.startsWith('diff --git'), 'expected diff header at start, got: ' + diff.slice(0, 40));
    assert.ok(diff.indexOf('-original') >= 0);
    assert.ok(diff.indexOf('+modified') >= 0);
  });
});

test('GIT-DIFF-2: gitDiffNoColor returns empty string when working tree matches HEAD', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'README.md', 'same\n', 'chore: seed');
    const diff = git.gitDiffNoColor('HEAD', 'README.md');
    assert.equal(diff, '');
  });
});

test('GIT-DIFF-3: gitDiffNoColor output strips ANSI even with color.ui=always (Pitfall 6)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    commitFile(root, 'README.md', 'red\n', 'chore: seed');
    execFileSync('git', ['-C', root, 'config', '--local', 'color.ui', 'always'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(root, 'README.md'), 'green\n', 'utf-8');
    const diff = git.gitDiffNoColor('HEAD', 'README.md');
    assert.ok(diff.length > 0);
    assert.equal(diff.indexOf('\x1b'), -1, 'output must contain no ESC bytes');
  });
});

test('GIT-CWD-1: commitTask({cwd}) commits into that working tree, not process.cwd()', () => {
  const outer = makeRepo();
  const inner = makeRepo();
  fs.writeFileSync(path.join(inner, 'in-worktree.txt'), 'from the worktree');

  const prev = process.cwd();
  process.chdir(outer);
  try {
    const res = git.commitTask('M001-S001-T0001', ['in-worktree.txt'], 'task(M001-S001-T0001): x', '', { cwd: inner });
    assert.equal(res.committed, true);
  } finally {
    process.chdir(prev);
  }

  const innerLog = execFileSync('git', ['-C', inner, 'log', '--oneline'], { encoding: 'utf-8' });
  assert.match(innerLog, /M001-S001-T0001/, 'the commit must land in the targeted working tree');
  const outerLog = execFileSync('git', ['-C', outer, 'log', '--oneline'], { encoding: 'utf-8' });
  assert.ok(!/M001-S001-T0001/.test(outerLog), 'and must NOT land on the calling branch');
});

test('GIT-LOCK-1: concurrent commitTask PROCESSES serialise instead of racing on index.lock', async () => {
  const { spawn } = require('node:child_process');
  const repo = makeRepo();
  const n = 6;
  for (let i = 0; i < n; i += 1) {
    fs.writeFileSync(path.join(repo, 'f' + i + '.txt'), 'content ' + i);
  }

  const gitLib = path.resolve(__dirname, 'git.cjs');
  const runner = path.join(repo, 'runner.cjs');
  fs.writeFileSync(runner, `
    const git = require(${JSON.stringify(gitLib)});
    const i = process.argv[2];
    const res = git.commitTask('M001-S001-T000' + i, ['f' + (i - 1) + '.txt'],
      'task(M001-S001-T000' + i + '): parallel', '', { cwd: ${JSON.stringify(repo)} });
    process.stdout.write(JSON.stringify(res));
  `);

  const codes = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [runner, String(i + 1)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ code, err }));
  })));

  const failed = codes.filter((c) => c.code !== 0);
  assert.deepEqual(failed.map((f) => f.err.split('\n')[0]), [],
    'no parallel commit may die on index.lock');

  const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf-8' });
  for (let i = 1; i <= n; i += 1) {
    assert.match(log, new RegExp('M001-S001-T000' + i), 'commit ' + i + ' must be in the log');
  }
  assert.ok(!fs.existsSync(path.join(repo, '.nubos-pilot', '.git-commit.lock')),
    'the lock must be released');
});

function makeNestedWorktree(root, sliceFullId) {
  const m = sliceFullId.match(/^(M\d{3,})-(S\d{3,})$/);
  const wt = path.join(root, '.nubos-pilot', 'worktrees', m[1], m[2]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'np/' + sliceFullId, wt], {
    stdio: 'pipe',
  });
  return wt;
}

test('GIT-CWD-2: restoreFiles(paths, cwd) restores in that working tree and does NOT touch the main repo (data loss)', () => {
  const root = makeRepo();
  commitFile(root, 'src/a.ts', 'export const a = 2;\n', 'chore: baseline');
  const wt = makeNestedWorktree(root, 'M001-S001');

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1; // UNCOMMITTED USER CHANGE\n');
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 999; // WORKTREE WORK\n');

  inRepo(root, () => {
    git.restoreFiles(['src/a.ts'], wt);
  });

  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8'),
    'export const a = 1; // UNCOMMITTED USER CHANGE\n',
    'the uncommitted user change in the MAIN repo must survive untouched',
  );
  assert.equal(
    fs.readFileSync(path.join(wt, 'src', 'a.ts'), 'utf-8'),
    'export const a = 2;\n',
    'the targeted worktree is the one that gets restored to HEAD',
  );
});

test('GIT-CWD-3: restoreFiles returns the paths it actually restored (payload truth)', () => {
  const root = makeRepo();
  commitFile(root, 'a.ts', 'original\n', 'chore: seed');
  fs.writeFileSync(path.join(root, 'a.ts'), 'mutated\n');

  assert.deepEqual(git.restoreFiles(['a.ts'], root), ['a.ts']);
  assert.deepEqual(git.restoreFiles([], root), [], 'empty input restores nothing');
  assert.throws(
    () => git.restoreFiles(['never-tracked.ts'], root),
    'a pathspec git cannot restore must throw, not be silently reported as restored',
  );
});

test('GIT-CWD-4: revertCommit(sha, cwd) reverts in that working tree, not process.cwd()', () => {
  const root = makeRepo();
  commitFile(root, 'a.ts', 'v1\n', 'chore: seed');
  const wt = makeNestedWorktree(root, 'M001-S001');
  execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@nubos-pilot.local']);
  execFileSync('git', ['-C', wt, 'config', 'user.name', 'nubos-test']);

  writeFile(wt, 'a.ts', 'v2\n');
  execFileSync('git', ['-C', wt, 'add', '--', 'a.ts'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'task(M001-S001-T0001): v2'], { stdio: 'pipe' });
  const sha = git.findCommitByTaskId('M001-S001-T0001', wt);

  const mainHeadBefore = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  inRepo(root, () => {
    git.revertCommit(sha, wt);
  });

  assert.equal(
    execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    mainHeadBefore,
    'the main repo branch must not move',
  );
  assert.match(
    execFileSync('git', ['-C', wt, 'log', '--oneline', '-n', '1'], { encoding: 'utf-8' }),
    /Revert/,
    'the revert commit lands in the targeted worktree',
  );
});

test('GIT-CWD-5: listTaskCommits(prefix, cwd) reads the log of that working tree', () => {
  const root = makeRepo();
  const other = makeRepo();
  writeFile(other, 'a.ts', 'x');
  git.commitTask('M009-S009-T0001', ['a.ts'], 'task(M009-S009-T0001): only here', '', { cwd: other });

  inRepo(root, () => {
    assert.deepEqual(git.listTaskCommits('M009-S009'), [], 'process.cwd() repo has no such commits');
    const list = git.listTaskCommits('M009-S009', other);
    assert.equal(list.length, 1);
    assert.match(list[0].subject, /^task\(M009-S009-T0001\):/);
  });
});

test('GIT-CWD-6: gitShowSafe(ref, filepath, cwd) reads from that working tree', () => {
  const root = makeRepo();
  const other = makeRepo();
  commitFile(other, 'README.md', 'from the other repo\n', 'chore: seed');

  inRepo(root, () => {
    assert.equal(git.gitShowSafe('HEAD', 'README.md'), null, 'process.cwd() repo has no README.md');
    assert.equal(git.gitShowSafe('HEAD', 'README.md', other), 'from the other repo\n');
  });
});

test('GIT-CWD-7: gitDiffNoColor(ref, filepath, cwd) diffs that working tree', () => {
  const root = makeRepo();
  const other = makeRepo();
  commitFile(other, 'README.md', 'v1\n', 'chore: seed');
  fs.writeFileSync(path.join(other, 'README.md'), 'v2\n', 'utf-8');

  inRepo(root, () => {
    assert.equal(git.gitDiffNoColor('HEAD', 'README.md'), '', 'process.cwd() repo is clean');
    const diff = git.gitDiffNoColor('HEAD', 'README.md', other);
    assert.match(diff, /^diff --git/, 'the targeted repo shows the mutation');
    assert.match(diff, /\+v2/);
  });
});

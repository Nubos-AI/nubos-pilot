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
    assert.match(captured, /\[nubos-pilot warn\] gitignored \(skipping\):/);
    assert.match(captured, /build\/out\.js/);
  });
});

test('GIT-3: assertCommittablePaths throws commit-all-paths-gitignored when every path ignored (D-25)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, '.gitignore', '.env\nsecret.txt\n');
    writeFile(root, '.env', 'X=1');
    writeFile(root, 'secret.txt', 'shh');
    assert.throws(
      () => git.assertCommittablePaths(['.env', 'secret.txt']),
      (err) => {
        return err.name === 'NubosPilotError'
          && err.code === 'commit-all-paths-gitignored'
          && Array.isArray(err.details.paths)
          && err.details.paths.includes('.env');
      },
    );
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
    git.commitTask('06-01-T01', ['lib/git.cjs'], 'task(06-01-T01): add git helper');
    const log = execFileSync('git', ['log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
    assert.equal(log, 'task(06-01-T01): add git helper');
    const stat = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { encoding: 'utf-8' });
    assert.match(stat, /lib\/git\.cjs/);
  });
});

test('GIT-6: findCommitByTaskId returns 40-char SHA for known task commit', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('06-01-T01', ['a.ts'], 'task(06-01-T01): add a.ts');
    const sha = git.findCommitByTaskId('06-01-T01');
    assert.match(sha, /^[0-9a-f]{40}$/);
  });
});

test('GIT-7: findCommitByTaskId throws task-commit-not-found when no commit matches', () => {
  const root = makeRepo();
  inRepo(root, () => {
    assert.throws(
      () => git.findCommitByTaskId('06-01-T99'),
      (err) => err.code === 'task-commit-not-found' && err.details.id === '06-01-T99',
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
      () => git.findCommitByTaskId('06-01-T01.*'),
      (err) => err.code === 'task-commit-not-found',
    );
  });
});

test('GIT-9: findCommitByTaskId is anchored — body-mention of stale task-id does not produce false match (Pitfall 3)', () => {
  const root = makeRepo();
  inRepo(root, () => {

    writeFile(root, 'a.ts', 'x');
    git.commitTask('06-01-T01', ['a.ts'], 'task(06-01-T01): real task');
    const realSha = git.findCommitByTaskId('06-01-T01');

    writeFile(root, 'b.ts', 'y');
    execFileSync('git', ['add', '--', 'b.ts']);
    execFileSync('git', [
      'commit',
      '-m',
      'task(06-01-T02): something',
      '-m',
      'See also task(06-01-T01) which we extended here.',
    ]);

    const t1 = git.findCommitByTaskId('06-01-T01');
    const t2 = git.findCommitByTaskId('06-01-T02');
    assert.equal(t1, realSha, 'T01 must still resolve to the original commit, not the body-mention');
    assert.notEqual(t1, t2);
  });
});

test('GIT-10: revertCommit creates a forward revert commit (no history rewrite)', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('06-01-T01', ['a.ts'], 'task(06-01-T01): add a.ts');
    const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim();
    const sha = git.findCommitByTaskId('06-01-T01');
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
    git.commitTask('06-01-T01', ['a.ts'], 'task(06-01-T01): add a.ts');
    fs.writeFileSync(path.join(root, 'a.ts'), 'mutated', 'utf-8');
    git.restoreFiles(['a.ts']);
    const content = fs.readFileSync(path.join(root, 'a.ts'), 'utf-8');
    assert.equal(content, 'original');
  });
});

test('GIT-12: listTaskCommits returns parsed array of {sha, subject} for a plan-id prefix', () => {
  const root = makeRepo();
  inRepo(root, () => {
    writeFile(root, 'a.ts', 'x');
    git.commitTask('06-01-T01', ['a.ts'], 'task(06-01-T01): first');
    writeFile(root, 'b.ts', 'y');
    git.commitTask('06-01-T02', ['b.ts'], 'task(06-01-T02): second');
    const list = git.listTaskCommits('06-01');
    assert.equal(list.length, 2);
    for (const entry of list) {
      assert.match(entry.sha, /^[0-9a-f]{40}$/);
      assert.match(entry.subject, /^task\(06-01-T0[12]\):/);
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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const commitCli = require('./commit.cjs');

const _sandboxes = [];

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-commit-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

function initGit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

test('COMMIT-1: happy path commits a single file and prints sha JSON', () => {
  const sb = makeSandbox();
  initGit(sb);
  fs.writeFileSync(path.join(sb, 'hello.txt'), 'hi\n');
  const stdout = makeSink();
  const stderr = makeSink();
  const origCwd = process.cwd();
  process.chdir(sb);
  let code;
  try {
    code = commitCli.run(['feat: hello', '--files', 'hello.txt'], { stdout, stderr });
  } finally {
    process.chdir(origCwd);
  }
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  assert.match(stdout.toString(), /"committed":\s*true/);
});

test('COMMIT-2: path with ".." segment rejected with commit-path-traversal', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = commitCli.run(['feat: x', '--files', '../outside.txt'], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"commit-path-traversal"/);
});

test('COMMIT-3: empty message prints usage and exits 1', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = commitCli.run([], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});

test('COMMIT-4: overlong message exceeds limit → commit-message-too-long', () => {
  const sb = makeSandbox();
  initGit(sb);
  fs.writeFileSync(path.join(sb, 'a.txt'), 'a');
  const stdout = makeSink();
  const stderr = makeSink();
  const origCwd = process.cwd();
  process.chdir(sb);
  let code;
  try {
    const huge = 'x'.repeat(3000);
    code = commitCli.run([huge, '--files', 'a.txt'], { stdout, stderr });
  } finally {
    process.chdir(origCwd);
  }
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"commit-message-too-long"/);
});

test('COMMIT-5: workflow.commit_artifacts=false skips commit silently with exit 0', () => {
  const sb = makeSandbox();
  initGit(sb);
  fs.writeFileSync(path.join(sb, 'note.md'), 'x');
  fs.writeFileSync(
    path.join(sb, '.nubos-pilot', 'config.json'),
    JSON.stringify({ workflow: { commit_artifacts: false } }),
  );
  const stdout = makeSink();
  const stderr = makeSink();
  const code = commitCli.run(['docs: note', '--files', 'note.md'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const out = stdout.toString();
  assert.match(out, /"committed":\s*false/);
  assert.match(out, /"reason":\s*"commit_artifacts=false"/);
  let logOut = '';
  try {
    logOut = execFileSync('git', ['log', '--oneline'], { cwd: sb, encoding: 'utf-8' }).trim();
  } catch { logOut = ''; }
  assert.equal(logOut, '', 'expected no commits to be created');
});

test('COMMIT-6: workflow.commit_artifacts=true still commits normally', () => {
  const sb = makeSandbox();
  initGit(sb);
  fs.writeFileSync(path.join(sb, 'note.md'), 'x');
  fs.writeFileSync(
    path.join(sb, '.nubos-pilot', 'config.json'),
    JSON.stringify({ workflow: { commit_artifacts: true } }),
  );
  const stdout = makeSink();
  const stderr = makeSink();
  const origCwd = process.cwd();
  process.chdir(sb);
  let code;
  try {
    code = commitCli.run(['docs: note', '--files', 'note.md'], { stdout, stderr });
  } finally {
    process.chdir(origCwd);
  }
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  assert.match(stdout.toString(), /"committed":\s*true/);
});

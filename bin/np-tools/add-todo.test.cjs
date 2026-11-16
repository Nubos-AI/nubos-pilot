const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const subcmd = require('./add-todo.cjs');

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-add-todo-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

function captureStdio(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  let rc;
  try { rc = fn(); } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), rc };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

test('AT-1: _buildPayload("Fix deploy key auth", sandbox) returns payload with kebab-case slug', () => {
  const cwd = makeSandbox();
  const payload = subcmd._buildPayload('Fix deploy key auth', cwd);
  assert.equal(payload._workflow, 'add-todo');
  assert.equal(payload.slug, 'fix-deploy-key-auth');
  assert.equal(payload.description, 'Fix deploy key auth');
  assert.equal(payload.commit_docs, true);
  assert.match(payload.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(payload.pending_dir.endsWith(path.join('.nubos-pilot', 'todos', 'pending')));
  assert.equal(payload.todo_count, 0);
  assert.equal(payload.todos_dir_exists, false);
});

test('AT-2: _buildPayload("", sandbox) throws NubosPilotError code "add-todo-missing-description"', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => subcmd._buildPayload('', cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'add-todo-missing-description',
  );
  assert.throws(
    () => subcmd._buildPayload('   ', cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'add-todo-missing-description',
  );
});

test('AT-3: _buildPayload(501-char string, sandbox) throws code "add-todo-description-too-long"', () => {
  const cwd = makeSandbox();
  const longDesc = 'x'.repeat(501);
  assert.throws(
    () => subcmd._buildPayload(longDesc, cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'add-todo-description-too-long',
  );
});

test('AT-4: payload.date matches YYYY-MM-DD and prefix of payload.timestamp', () => {
  const cwd = makeSandbox();
  const payload = subcmd._buildPayload('Refactor the router', cwd);
  assert.equal(payload.date.length, 10);
  assert.equal(payload.timestamp.slice(0, 10), payload.date);
});

test('AT-5: run([]) writes usage to stderr and returns 1', () => {
  const cap = captureStdio(() => subcmd.run([]));
  assert.equal(cap.rc, 1);
  assert.match(cap.stderr, /Usage:\s+np-tools\.cjs init add-todo/);
});

test('AT-6: run(["Fix deploy key auth"]) emits JSON with slug on stdout and exits 0', () => {
  const cwd = makeSandbox();
  const orig = process.cwd();
  process.chdir(cwd);
  try {
    const cap = captureStdio(() => subcmd.run(['Fix', 'deploy', 'key', 'auth']));
    assert.equal(cap.rc, 0, 'stderr: ' + cap.stderr);
    const parsed = JSON.parse(cap.stdout);
    assert.equal(parsed.slug, 'fix-deploy-key-auth');
    assert.equal(parsed._workflow, 'add-todo');
  } finally {
    process.chdir(orig);
  }
});

test('AT-7: todo_count reflects existing .md files in pending/', () => {
  const cwd = makeSandbox();
  const pending = path.join(cwd, '.nubos-pilot', 'todos', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, '2026-04-01-first.md'), '---\n---\n', 'utf-8');
  fs.writeFileSync(path.join(pending, '2026-04-02-second.md'), '---\n---\n', 'utf-8');
  fs.writeFileSync(path.join(pending, 'ignore-me.txt'), 'x', 'utf-8');
  const payload = subcmd._buildPayload('Something new', cwd);
  assert.equal(payload.todo_count, 2);
  assert.equal(payload.todos_dir_exists, true);
});

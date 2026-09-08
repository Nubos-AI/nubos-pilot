const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { scan, DEFAULT_IGNORES, MANIFEST_FILES } = require('./workspace-scan.cjs');
const { workspaceGitInfo } = require('./git.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ws-scan-'));
  _sandboxes.push(dir);
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('WS-1: empty directory returns zero files', () => {
  const root = makeSandbox();
  const result = scan({ cwd: root });
  assert.equal(result.stats.file_count, 0);
  assert.equal(result.stats.hashed_count, 0);
  assert.deepEqual(result.files, []);
  assert.equal(result.git.is_repo, false);
});

test('WS-2: walks regular source files and hashes them', () => {
  const root = makeSandbox();
  write(root, 'src/index.js', 'console.log("hi");\n');
  write(root, 'src/util.js', 'module.exports = {};\n');
  write(root, 'lib/helper.py', 'def f(): pass\n');

  const result = scan({ cwd: root });
  assert.equal(result.stats.file_count, 3);
  assert.equal(result.stats.hashed_count, 3);
  const paths = result.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['lib/helper.py', 'src/index.js', 'src/util.js']);
  for (const f of result.files) {
    assert.match(f.sha256, /^sha256:[a-f0-9]{64}$/);
  }
});

test('WS-3: ignores node_modules / .git / vendor / .nubos-pilot', () => {
  const root = makeSandbox();
  write(root, 'src/a.js', 'a');
  write(root, 'node_modules/foo/index.js', 'foo');
  write(root, 'vendor/libx/x.php', 'x');
  write(root, '.git/HEAD', 'ref: refs/heads/main');
  write(root, '.nubos-pilot/PROJECT.md', '# project');

  const result = scan({ cwd: root });
  const paths = result.files.map((f) => f.path);
  assert.deepEqual(paths, ['src/a.js']);
});

test('WS-4: captures manifest content (package.json) verbatim', () => {
  const root = makeSandbox();
  const pkg = { name: 'demo', version: '1.0.0', dependencies: { express: '^4' } };
  write(root, 'package.json', JSON.stringify(pkg, null, 2));

  const result = scan({ cwd: root });
  assert.ok(result.manifests['package.json']);
  const parsed = JSON.parse(result.manifests['package.json'].content);
  assert.equal(parsed.name, 'demo');
  assert.equal(parsed.dependencies.express, '^4');
});

test('WS-5: captures README as a doc', () => {
  const root = makeSandbox();
  write(root, 'README.md', '# Demo\n\nHello world.\n');

  const result = scan({ cwd: root });
  assert.ok(result.docs['README.md']);
  assert.ok(result.docs['README.md'].content.includes('Demo'));
});

test('WS-6: language_distribution counts extensions', () => {
  const root = makeSandbox();
  write(root, 'a.js', 'a');
  write(root, 'b.js', 'b');
  write(root, 'c.py', 'c');
  write(root, 'Makefile', 'all:\n');

  const result = scan({ cwd: root });
  assert.equal(result.language_distribution['.js'], 2);
  assert.equal(result.language_distribution['.py'], 1);
  assert.equal(result.language_distribution['<no-ext>'], 1);
});

test('WS-7: onProgress emits batch events', () => {
  const root = makeSandbox();
  for (let i = 0; i < 5; i++) write(root, `f${i}.txt`, 'x');

  const events = [];
  scan({ cwd: root, batchSize: 2, onProgress: (e) => events.push(e.phase) });
  assert.ok(events.includes('walk-start'));
  assert.ok(events.includes('walk-complete'));
  assert.ok(events.includes('batch-start'));
  assert.ok(events.includes('batch-done'));
  assert.equal(events[events.length - 1], 'complete');
});

test('WS-8: binary extensions skip hashing', () => {
  const root = makeSandbox();
  write(root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(root, 'code.js', 'x');

  const result = scan({ cwd: root });
  const hashed = result.files.map((f) => f.path);
  assert.deepEqual(hashed, ['code.js']);
  const skippedPaths = result.skipped.map((s) => s.path);
  assert.ok(skippedPaths.includes('logo.png'));
});

test('WS-9: additionalIgnores extend the default ignore set', () => {
  const root = makeSandbox();
  write(root, 'src/a.js', 'a');
  write(root, 'generated/big.js', 'g');

  const result = scan({ cwd: root, additionalIgnores: ['generated'] });
  const paths = result.files.map((f) => f.path);
  assert.deepEqual(paths, ['src/a.js']);
});

test('WS-10: detects git repo and captures commits', () => {
  const root = makeSandbox();
  write(root, 'a.txt', 'a');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'a.txt'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  } catch {
    return;
  }

  const result = scan({ cwd: root, gitInfo: workspaceGitInfo });
  assert.equal(result.git.is_repo, true);
  assert.ok(Array.isArray(result.git.commits));
  assert.ok(result.git.commits.length >= 1);
  assert.equal(result.git.commits[0].subject, 'init');
});

test('WS-11: throws scan-not-a-directory for file path', () => {
  const root = makeSandbox();
  const filePath = path.join(root, 'not-a-dir.txt');
  fs.writeFileSync(filePath, 'x');
  assert.throws(
    () => scan({ cwd: filePath }),
    (err) => err.code === 'scan-not-a-directory',
  );
});

test('WS-12: manifest file triggers capture even in nested dir', () => {
  const root = makeSandbox();
  write(root, 'services/api/package.json', JSON.stringify({ name: 'api' }));
  write(root, 'services/api/src/main.ts', 'export {};');

  const result = scan({ cwd: root });
  assert.ok(result.manifests['services/api/package.json']);
});

test('WS-13: stats counts match produced arrays', () => {
  const root = makeSandbox();
  write(root, 'a.js', 'a');
  write(root, 'b.js', 'b');
  write(root, 'README.md', '# x');
  write(root, 'package.json', '{}');

  const result = scan({ cwd: root });
  assert.equal(result.stats.file_count, 4);
  assert.equal(result.stats.manifest_count, Object.keys(result.manifests).length);
  assert.equal(result.stats.doc_count, Object.keys(result.docs).length);
  assert.equal(result.stats.hashed_count, result.files.length);
});

test('WS-14: dotfiles like .nvmrc are walked but .idea directory is ignored', () => {
  const root = makeSandbox();
  write(root, '.nvmrc', '22');
  write(root, '.idea/workspace.xml', '<x/>');
  write(root, 'src/a.js', 'a');

  const result = scan({ cwd: root });
  const paths = result.files.map((f) => f.path).sort();
  assert.ok(paths.includes('.nvmrc'));
  assert.ok(paths.includes('src/a.js'));
  assert.ok(!paths.some((p) => p.startsWith('.idea')));
});

test('WS-15: MANIFEST_FILES set is frozen and contains known ones', () => {
  assert.ok(MANIFEST_FILES.has('package.json'));
  assert.ok(MANIFEST_FILES.has('Cargo.toml'));
  assert.ok(MANIFEST_FILES.has('go.mod'));
  assert.ok(MANIFEST_FILES.has('composer.json'));
  assert.ok(DEFAULT_IGNORES.has('node_modules'));
  assert.ok(DEFAULT_IGNORES.has('.git'));
});

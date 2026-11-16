const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

test('backup: backupFile without collision writes <file>.bak (D-05)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-1');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(dir, 'config.md');
  fs.writeFileSync(target, 'user content');
  const bakPath = backupFile(target);
  assert.equal(bakPath, target + '.bak');
  assert.ok(fs.existsSync(bakPath));
  assert.equal(fs.readFileSync(bakPath, 'utf-8'), 'user content');
});

test('backup: backupFile with existing .bak writes .bak.1 (D-05)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-2');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(dir, 'config.md');
  fs.writeFileSync(target, 'user content v2');
  fs.writeFileSync(target + '.bak', 'prior-backup');
  const bakPath = backupFile(target);
  assert.equal(bakPath, target + '.bak.1');
  assert.ok(fs.existsSync(bakPath));
  assert.equal(fs.readFileSync(bakPath, 'utf-8'), 'user content v2');
  assert.equal(fs.readFileSync(target + '.bak', 'utf-8'), 'prior-backup', 'prior .bak untouched');
});

test('backup: destDir places the backup outside the source tree, preserving relPath (P2.3)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-dest');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const payloadDir = path.join(dir, '.claude', 'nubos-pilot');
  const backupRoot = path.join(dir, '.nubos-pilot', 'backups', 'ts');
  const target = path.join(payloadDir, 'agents', 'np-critic.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'user edit');

  const bakPath = backupFile(target, { destDir: backupRoot, relPath: 'agents/np-critic.md' });

  assert.equal(bakPath, path.join(backupRoot, 'agents', 'np-critic.md.bak'));
  assert.equal(fs.readFileSync(bakPath, 'utf-8'), 'user edit');
  assert.ok(!fs.existsSync(target), 'original is moved, not copied');
  assert.ok(!bakPath.startsWith(payloadDir), 'backup must not live inside the swapped payload dir');
});

test('backup: destDir backup survives finalizeSwap — the P2.3 regression', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const staging = require('../../lib/install/staging.cjs');
  const dir = mkTmp('backup-swap');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const payloadDir = path.join(dir, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  const target = path.join(payloadDir, 'config.md');
  fs.writeFileSync(target, 'precious user edit');

  const backupRoot = path.join(dir, '.nubos-pilot', 'backups', 'ts');
  const bakPath = backupFile(target, { destDir: backupRoot, relPath: 'config.md' });

  // finalizeSwap renames payloadDir aside and rmSync's it. A sibling .bak dies here.
  const tmp = staging.stageDir(dir);
  fs.writeFileSync(path.join(tmp, 'config.md'), 'fresh payload');
  staging.finalizeSwap(dir);

  assert.ok(fs.existsSync(bakPath), 'backup must still exist after finalizeSwap');
  assert.equal(fs.readFileSync(bakPath, 'utf-8'), 'precious user edit');
});

test('backup: sibling .bak is destroyed by finalizeSwap — documents why destDir exists (P2.3)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const staging = require('../../lib/install/staging.cjs');
  const dir = mkTmp('backup-swap-old');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const payloadDir = path.join(dir, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  const target = path.join(payloadDir, 'config.md');
  fs.writeFileSync(target, 'precious user edit');

  const bakPath = backupFile(target); // legacy sibling behaviour
  assert.ok(fs.existsSync(bakPath));

  const tmp = staging.stageDir(dir);
  fs.writeFileSync(path.join(tmp, 'config.md'), 'fresh payload');
  staging.finalizeSwap(dir);

  assert.ok(!fs.existsSync(bakPath), 'sibling .bak is collateral of the swap — this is the defect');
});

test('backup: destDir rejects a relPath escaping the backup root (P2.3)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-traversal');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(dir, 'config.md');
  fs.writeFileSync(target, 'x');
  assert.throws(
    () => backupFile(target, { destDir: path.join(dir, 'backups'), relPath: '../../escape.md' }),
    /backup-rel-path-traversal|Refusing to place a backup outside/,
  );
  assert.ok(fs.existsSync(target), 'original untouched when the path is rejected');
});

// The relPath guard is purely lexical (isAbsolute / '..'), so it cannot see a
// symlinked SUBDIRECTORY of destDir: path.join stays inside destDir as a string
// while copyFileSync writes straight through the link. install.js does the
// realpath+prefix check for its unlinks (bin/install.js:613, :783) — writes must
// hold the same line.
test('backup: destDir rejects a symlinked subdirectory escaping the backup root (D3)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-symlink-dest');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const destDir = path.join(dir, 'dest');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(destDir, 'hooks'));

  const target = path.join(dir, 'x.txt');
  fs.writeFileSync(target, 'user content');

  assert.throws(
    () => backupFile(target, { destDir, relPath: 'hooks/x.txt' }),
    (err) => err.code === 'backup-dest-escape',
    'a backup must never be written through a symlinked subdir of destDir',
  );
  assert.deepEqual(fs.readdirSync(outside), [],
    'canary: nothing may leak outside destDir');
  assert.ok(fs.existsSync(target), 'original untouched when the path is rejected');
});

test('backup: destDir accepts a legitimate nested relPath after the realpath check (D3)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-nested-ok');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const destDir = path.join(dir, 'dest');
  const target = path.join(dir, 'y.txt');
  fs.writeFileSync(target, 'keep me');
  const bak = backupFile(target, { destDir, relPath: 'a/b/y.txt' });
  assert.equal(bak, path.join(destDir, 'a', 'b', 'y.txt.bak'));
  assert.equal(fs.readFileSync(bak, 'utf-8'), 'keep me');
});

test('backup: a real re-install leaves the conflict backup on disk (P2.3 end-to-end)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('backup-e2e');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  // A real installation always carries a config naming its runtimes; an install
  // that cannot resolve one now fails closed (D2), so seed it like init would.
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: 'claude', runtimes: ['claude'], scope: 'local' }, null, 2));
  fs.writeFileSync(path.join(payloadDir, 'kept.md'), 'USER EDIT worth keeping');
  // 'aa' is a stale hash: it differs from both the on-disk file and the new
  // source, so kept.md lands in diff.changed AND trips the conflict branch.
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '0.0.1',
    timestamp: '2026-04-10T00:00:00Z',
    files: { 'kept.md': 'aa' },
  }));

  const sourceDir = mkTmp('backup-e2e-src');
  t.after(() => { try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(sourceDir, 'kept.md'), 'fresh payload from source');

  await install.runInstall({
    cwd: root,
    mode: 're-install',
    sourceDir,
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });

  const backupsRoot = path.join(root, '.nubos-pilot', 'backups');
  assert.ok(fs.existsSync(backupsRoot), '.nubos-pilot/backups/ must exist after a conflict');
  const stamps = fs.readdirSync(backupsRoot);
  assert.equal(stamps.length, 1, 'exactly one timestamped backup dir for this run');
  const bak = path.join(backupsRoot, stamps[0], 'kept.md.bak');
  assert.ok(fs.existsSync(bak), 'the conflict backup must survive the payload swap');
  assert.equal(fs.readFileSync(bak, 'utf-8'), 'USER EDIT worth keeping');
  assert.equal(fs.readFileSync(path.join(payloadDir, 'kept.md'), 'utf-8'),
    'fresh payload from source', 'payload itself is swapped to the new version');
});

test('backup: numbering caps at .bak.99 and falls back to .bak.orphan-<timestamp> (D-05 + Pitfall 7)', (t) => {
  const { backupFile } = require('../../lib/install/backup.cjs');
  const dir = mkTmp('backup-cap');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(dir, 'config.md');
  fs.writeFileSync(target, 'current');
  fs.writeFileSync(target + '.bak', 'b0');
  for (let i = 1; i <= 99; i++) fs.writeFileSync(target + '.bak.' + i, 'b' + i);
  const bakPath = backupFile(target);
  assert.ok(
    /\.bak\.orphan-/.test(bakPath),
    'beyond .bak.99 must fall back to .bak.orphan-<ts>, got: ' + bakPath,
  );
  assert.ok(fs.existsSync(bakPath));
});

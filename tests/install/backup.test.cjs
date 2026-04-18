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

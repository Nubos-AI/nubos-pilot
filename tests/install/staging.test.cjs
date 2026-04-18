const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

test('staging: stageDir creates .claude/nubos-pilot.tmp/ under given root (D-08)', (t) => {
  const { stageDir } = require('../../lib/install/staging.cjs');
  const root = mkTmp('staging-stage');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const tmp = stageDir(root);
  assert.ok(tmp.endsWith(path.join('.claude', 'nubos-pilot.tmp')));
  assert.ok(fs.existsSync(tmp));
  assert.ok(fs.statSync(tmp).isDirectory());
});

test('staging: finalizeSwap renames tmp→target even when target exists+non-empty (D-08)', (t) => {
  const { stageDir, finalizeSwap } = require('../../lib/install/staging.cjs');
  const root = mkTmp('staging-swap');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const target = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'old.md'), 'old content');
  const tmp = stageDir(root);
  fs.writeFileSync(path.join(tmp, 'new.md'), 'new content');
  finalizeSwap(root);
  assert.ok(fs.existsSync(path.join(target, 'new.md')));
  assert.ok(!fs.existsSync(path.join(target, 'old.md')), 'old file must be gone after swap');
  assert.ok(!fs.existsSync(tmp), 'staging dir must be gone after swap');
});

test('staging: cleanStaleStaging removes orphan .tmp/ (D-08 crash-recovery)', (t) => {
  const { cleanStaleStaging } = require('../../lib/install/staging.cjs');
  const root = mkTmp('staging-clean');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const orphan = path.join(root, '.claude', 'nubos-pilot.tmp');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'leftover.md'), 'crash leftover');
  cleanStaleStaging(root);
  assert.ok(!fs.existsSync(orphan), 'orphan .tmp/ must be removed');
});

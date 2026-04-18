const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}
function capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

test('doctor: default run emits {issues: [...]} without mutating FS (INST-05, D-15)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-default');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const before = fs.readdirSync(root);
  const cap = capture();
  await doctor.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(Array.isArray(payload.issues), 'default run must emit issues array');
  assert.deepEqual(fs.readdirSync(root), before, 'FS unchanged in default run');
});

test('doctor: missing manifest produces issue {id: "missing-manifest"} (INST-05)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-missing');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const cap = capture();
  await doctor.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(payload.issues.some((i) => i.id === 'missing-manifest'),
    'must report missing-manifest when .claude/nubos-pilot/.manifest.json absent');
});

test('doctor: --fix applies auto-fixable issues without prompting (D-16)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-fix');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const cap = capture();
  let askCalled = false;
  const mockAskUser = async () => { askCalled = true; throw new Error('must not prompt for auto-fix'); };
  await doctor.run(['--fix'], { cwd: root, stdout: cap.stub, askUser: mockAskUser });
  assert.equal(askCalled, false, 'auto-fixable issues must never call askUser (D-16 whitelist)');
});

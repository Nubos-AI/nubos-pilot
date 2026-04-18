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

test('triage: per-item askUser call offers 4 options (promote-to-todo/promote-to-phase/keep/drop) (D-25)', async (t) => {
  const triage = require('../../bin/np-tools/triage.cjs');
  const root = mkTmp('triage-loop');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'todos', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'todos', 'pending', 't1.md'), '# todo one\n');

  const seen = [];
  const mockAskUser = async (spec) => {
    seen.push(spec);
    return { value: 'keep', source: 'test' };
  };
  const cap = capture();
  await triage.run([], { cwd: root, stdout: cap.stub, askUser: mockAskUser });
  assert.ok(seen.length >= 1, 'at least one per-item askUser call expected');
  const s0 = seen[0];
  assert.deepEqual(
    (s0.options || []).slice().sort(),
    ['drop', 'keep', 'promote-to-phase', 'promote-to-todo'].sort(),
    'triage options must include all 4 decision modes',
  );
});

test('triage: non-TTY run with no items exits 0 cleanly (D-25)', async (t) => {
  const triage = require('../../bin/np-tools/triage.cjs');
  const root = mkTmp('triage-empty');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  let askCount = 0;
  const mockAskUser = async () => { askCount++; return { value: 'keep', source: 'test' }; };
  const cap = capture();
  const res = await triage.run([], { cwd: root, stdout: cap.stub, askUser: mockAskUser });
  assert.equal(askCount, 0, 'no items → no askUser calls');
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
});

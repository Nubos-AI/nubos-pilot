const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./park.cjs');

const _roots = [];

function makeRoot(taskId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-park-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), [
    '---', `id: ${taskId}`, `milestone: ${mId}`, `slice: ${mId}-${sId}`, 'type: execute',
    'status: pending', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified: []', 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# T',
  ].join('\n'), 'utf-8');
  _roots.push(root);
  return { root, taskFile: path.join(taskDir, tId + '-PLAN.md') };
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('PK-1: park missing id', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'park-missing-task-id',
  );
});

test('PK-2: park flips status to parked', () => {
  const { root, taskFile } = makeRoot('M006-S001-T0002');
  const cap = _capture();
  subcmd.run(['M006-S001-T0002'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.status, 'parked');
  assert.match(fs.readFileSync(taskFile, 'utf-8'), /^status: parked$/m);
});

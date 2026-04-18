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
  const tasksDir = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, taskId + '.md'), [
    '---', `id: ${taskId}`, 'phase: 6', 'plan: "06-01"', 'type: auto',
    'status: pending', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified: []', 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# T',
  ].join('\n'), 'utf-8');
  _roots.push(root);
  return root;
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
  const root = makeRoot('06-01-T02');
  const cap = _capture();
  subcmd.run(['06-01-T02'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.status, 'parked');
  const tf = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks', '06-01-T02.md');
  assert.match(fs.readFileSync(tf, 'utf-8'), /^status: parked$/m);
});

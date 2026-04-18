const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./unpark.cjs');

const _roots = [];

function makeRoot(taskId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-unpark-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const tasksDir = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, taskId + '.md'), [
    '---', `id: ${taskId}`, 'phase: 6', 'plan: "06-01"', 'type: auto',
    'status: parked', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
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

test('UP-1: unpark missing id', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'unpark-missing-task-id',
  );
});

test('UP-2: unpark flips status to pending', () => {
  const root = makeRoot('06-01-T03');
  const cap = _capture();
  subcmd.run(['06-01-T03'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.status, 'pending');
  const tf = path.join(root, '.nubos-pilot', 'phases', '06-demo', 'tasks', '06-01-T03.md');
  assert.match(fs.readFileSync(tf, 'utf-8'), /^status: pending$/m);
});

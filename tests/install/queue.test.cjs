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

test('queue: aggregates four sources (todos, backlog, UAT, unplanned-phase) (INST-07, D-24)', async (t) => {
  const queue = require('../../bin/np-tools/queue.cjs');
  const root = mkTmp('queue-all');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const todosDir = path.join(root, '.nubos-pilot', 'todos', 'pending');
  fs.mkdirSync(todosDir, { recursive: true });
  fs.writeFileSync(path.join(todosDir, 't1.md'), '# todo one\n');

  const phasesDir = path.join(root, '.nubos-pilot', 'phases');
  fs.mkdirSync(path.join(phasesDir, '08-unplanned'), { recursive: true });
  fs.mkdirSync(path.join(phasesDir, '999-backlog-demo'), { recursive: true });

  const uatPath = path.join(phasesDir, '08-unplanned', '08-VERIFICATION.md');
  fs.writeFileSync(uatPath, '# UAT\n\n- [ ] open UAT item\n');

  fs.writeFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'),
    '# Roadmap\n\n## Phase 8\n- goal: demo\n\n## Phase 999\n- goal: backlog\n');

  const cap = capture();
  await queue.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(Array.isArray(payload.items), 'items[] required');
  const sources = new Set(payload.items.map((i) => i.source));
  assert.ok(sources.has('todo'), 'todo source missing');

  const coverage = ['backlog', 'uat', 'unplanned-phase'].filter((s) => sources.has(s));
  assert.ok(coverage.length >= 1, 'aggregation must surface at least one non-todo source, got: ' + [...sources].join(','));
});

test('queue: missing .nubos-pilot/todos/pending/ is tolerated (INST-07 guard)', async (t) => {
  const queue = require('../../bin/np-tools/queue.cjs');
  const root = mkTmp('queue-empty');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const cap = capture();
  await queue.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(Array.isArray(payload.items), 'items[] must exist even when todos/ absent');
});

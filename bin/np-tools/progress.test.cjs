const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const progressCmd = require('./progress.cjs');

const sandboxes = [];
function mkTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-progress-cmd-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'));
  sandboxes.push(root);
  return root;
}
afterEach(() => {
  while (sandboxes.length) {
    const p = sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

test('PROG-CMD-1: run returns persisted progress block from STATE.md', () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: 1\ncurrent_plan: null\ncurrent_task: null\n' +
    'last_updated: 2026-04-15\n' +
    'progress:\n' +
    '  total_phases: 5\n  completed_phases: 2\n  total_plans: 11\n  completed_plans: 4\n  percent: 36\n' +
    '---\n\n# S\n');
  const payload = progressCmd.run([], root);
  assert.equal(payload.total_phases, 5);
  assert.equal(payload.completed_phases, 2);
  assert.equal(payload.total_plans, 11);
  assert.equal(payload.completed_plans, 4);
  assert.equal(payload.percent, 36);
});

test('PROG-CMD-2: run on fresh sandbox (no STATE.md) returns zero-block', () => {
  const root = mkTmp();
  const payload = progressCmd.run([], root);
  assert.equal(payload.total_phases, 0);
  assert.equal(payload.percent, 0);
});

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateCmd = require('./state.cjs');

const sandboxes = [];
function mkTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-state-cmd-'));
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

test('STATE-CMD-1: run returns full v2 frontmatter', () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\nmilestone: v1.0\ncurrent_phase: 4\ncurrent_plan: 04-02\n' +
    'current_task: null\nlast_updated: 2026-04-15\n---\n\n# s\n');
  const payload = stateCmd.run([], root);
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.current_phase, 4);
  assert.equal(payload.current_plan, '04-02');
});

test('STATE-CMD-2: run on fresh sandbox returns error envelope payload (no STATE.md)', () => {
  const root = mkTmp();

  const payload = stateCmd.run([], root);
  assert.ok(payload && payload.error);
  assert.match(payload.error.code, /state-not-found|ENOENT/);
});

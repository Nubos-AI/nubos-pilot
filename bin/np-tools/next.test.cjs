const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nextCmd = require('./next.cjs');

const sandboxes = [];
function mkTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-next-cmd-'));
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

test('NEXT-CMD-1: run on fresh sandbox returns rule-1 JSON payload', () => {
  const root = mkTmp();
  const payload = nextCmd.run([], root);
  assert.ok(payload.next_step);
  assert.equal(payload.next_step.command, '/np:discuss-phase 1');
  assert.equal(payload.task, null);
  assert.equal(payload.phase, 1);
});

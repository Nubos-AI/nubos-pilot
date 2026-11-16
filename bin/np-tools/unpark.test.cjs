const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const subcmd = require('./unpark.cjs');

const { makeTempDir, seedTask: seedTaskFixture, captureOutput: _capture } = require('../../lib/__tests__/fixtures.cjs');

function makeRoot(taskId) {
  const root = makeTempDir();
  const taskFile = seedTaskFixture(root, taskId, { status: 'parked' });
  return { root, taskFile };
}

test('UP-1: unpark missing id', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'unpark-missing-task-id',
  );
});

test('UP-2: unpark flips status to pending', () => {
  const { root, taskFile } = makeRoot('M006-S001-T0003');
  const cap = _capture();
  subcmd.run(['M006-S001-T0003'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.status, 'pending');
  assert.match(fs.readFileSync(taskFile, 'utf-8'), /^status: pending$/m);
});

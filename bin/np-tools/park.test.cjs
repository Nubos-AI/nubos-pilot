const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const subcmd = require('./park.cjs');

const { makeTempDir, seedTask: seedTaskFixture, captureOutput: _capture } = require('../../lib/__tests__/fixtures.cjs');

function makeRoot(taskId) {
  const root = makeTempDir();
  const taskFile = seedTaskFixture(root, taskId, { status: 'pending' });
  return { root, taskFile };
}

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

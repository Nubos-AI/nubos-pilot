'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { captureSnapshot, writeSnapshot, readSnapshot } = require('./session-snapshot.cjs');
const { writeState } = require('./state.cjs');

function _scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-snapshot-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'handoffs'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'snap@test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Snap'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'task(M001-S001-T0001): initial'], { stdio: 'ignore' });
  writeState({ frontmatter: {
    schema_version: 2,
    milestone: 'M001',
    milestone_name: 'Test Milestone',
    current_task: 'M001-S001-T0001',
    last_updated: new Date().toISOString(),
    progress: { total_milestones: 1, completed_milestones: 0, total_tasks: 1, completed_tasks: 0, percent: 0 },
    session: { stopped_at: null, resume_file: null, last_activity: null },
  }, body: '\n# State\n' }, root);
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'handoffs', 'h1.md'),
    '---\nfrom: a\nto: b\nstatus: open\n---\nbody\n',
  );
  return root;
}

test('captureSnapshot pulls state + caller-supplied commits + handoffs', () => {
  const root = _scratch();
  const snap = captureSnapshot(root, {
    lastCommits: [{ sha: 'abc1234', subject: 'task: t1', committed_at: '2026-04-28T00:00:00Z' }],
  });
  assert.equal(snap.version, 1);
  assert.equal(snap.milestone, 'M001');
  assert.equal(snap.current_task, 'M001-S001-T0001');
  assert.equal(snap.last_commits.length, 1);
  assert.equal(snap.last_commits[0].sha, 'abc1234');
  assert.equal(snap.open_handoffs.length, 1);
  assert.equal(snap.open_handoffs[0].status, 'open');
});

test('captureSnapshot defaults last_commits to [] when not supplied', () => {
  const root = _scratch();
  const snap = captureSnapshot(root);
  assert.deepEqual(snap.last_commits, []);
});

test('writeSnapshot + readSnapshot round-trip', () => {
  const root = _scratch();
  const snap = captureSnapshot(root, { lastCommits: [] });
  const dest = writeSnapshot(snap, root);
  assert.ok(fs.existsSync(dest));
  const back = readSnapshot(root);
  assert.equal(back.milestone, snap.milestone);
  assert.equal(back.current_task, snap.current_task);
});

test('readSnapshot returns null when missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-snapshot-empty-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  assert.equal(readSnapshot(root), null);
});

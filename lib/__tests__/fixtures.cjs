'use strict';

const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const roots = [];
after(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempDir(prefix = 'np-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeRepo() {
  const root = makeTempDir('np-git-');
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@nubos.local'],
    ['config', 'user.name', 'nubos-test'],
    ['commit', '--allow-empty', '-q', '-m', 'chore: init'],
  ]) execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  return root;
}

function seedTask(root, taskId, { status = 'done', files = [] } = {}) {
  const match = /^(M\d{3,})-(S\d{3,})-(T\d{4,})$/.exec(taskId);
  if (!match) throw new Error('Invalid test task id: ' + taskId);
  const [, milestone, slice, task] = match;
  const dir = path.join(root, '.nubos-pilot', 'milestones', milestone, 'slices', slice, 'tasks', task);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, task + '-PLAN.md');
  fs.writeFileSync(file, [
    '---', `id: ${taskId}`, `milestone: ${milestone}`, `slice: ${milestone}-${slice}`,
    'type: execute', `status: ${status}`, 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', `files_modified: ${JSON.stringify(files)}`, 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# Task',
  ].join('\n'), 'utf-8');
  return file;
}

function captureOutput() {
  let output = '';
  return { stub: { write: (chunk) => { output += chunk; } }, get: () => output };
}

module.exports = { makeTempDir, makeRepo, seedTask, captureOutput };

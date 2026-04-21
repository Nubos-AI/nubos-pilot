'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COMMIT_ARTIFACTS,
  readConfigCommitArtifacts,
  resolveCommitArtifacts,
  resolveCommitArtifactsDetail,
} = require('./commit-policy.cjs');

const _sandboxes = [];

function makeSandbox(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-commit-policy-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  }
  _sandboxes.push(root);
  return root;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

test('CP-1: default is true when config absent', () => {
  const sb = makeSandbox();
  assert.equal(resolveCommitArtifacts(sb), true);
  assert.equal(DEFAULT_COMMIT_ARTIFACTS, true);
});

test('CP-2: workflow.commit_artifacts=false is respected', () => {
  const sb = makeSandbox({ workflow: { commit_artifacts: false } });
  assert.equal(resolveCommitArtifacts(sb), false);
  assert.deepEqual(resolveCommitArtifactsDetail(sb), { enabled: false, source: 'config' });
});

test('CP-3: workflow.commit_artifacts=true is respected', () => {
  const sb = makeSandbox({ workflow: { commit_artifacts: true } });
  assert.equal(resolveCommitArtifacts(sb), true);
  assert.deepEqual(resolveCommitArtifactsDetail(sb), { enabled: true, source: 'config' });
});

test('CP-4: missing workflow.commit_artifacts key falls back to default', () => {
  const sb = makeSandbox({ workflow: { text_mode: true } });
  assert.equal(resolveCommitArtifacts(sb), true);
  assert.deepEqual(resolveCommitArtifactsDetail(sb), { enabled: true, source: 'default' });
});

test('CP-5: invalid JSON surfaces as commit-policy-config-parse-error', () => {
  const sb = makeSandbox('{ "workflow": { "commit_artifacts": false ');
  assert.throws(
    () => readConfigCommitArtifacts(sb),
    (err) => err && err.code === 'commit-policy-config-parse-error',
  );
});

test('CP-6: string "false" / "off" / "0" coerce to false', () => {
  for (const val of ['false', 'off', '0', 'no']) {
    const sb = makeSandbox({ workflow: { commit_artifacts: val } });
    assert.equal(resolveCommitArtifacts(sb), false, 'expected ' + val + ' → false');
  }
});

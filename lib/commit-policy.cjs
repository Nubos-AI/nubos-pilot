'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot, NubosPilotError } = require('./core.cjs');

const DEFAULT_COMMIT_ARTIFACTS = true;

function _coerceBool(raw) {
  if (raw === true || raw === false) return raw;
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function readConfigCommitArtifacts(cwd) {
  let root;
  try {
    root = findProjectRoot(cwd || process.cwd());
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    throw err;
  }
  const p = path.join(root, '.nubos-pilot', 'config.json');
  if (!fs.existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new NubosPilotError('commit-policy-config-parse-error', 'config.json invalid JSON', { cause: err && err.message });
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const workflow = parsed.workflow;
  if (!workflow || typeof workflow !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(workflow, 'commit_artifacts')) return null;
  return _coerceBool(workflow.commit_artifacts);
}

function resolveCommitArtifacts(cwd) {
  const fromConfig = readConfigCommitArtifacts(cwd);
  if (fromConfig !== null) return fromConfig;
  return DEFAULT_COMMIT_ARTIFACTS;
}

function resolveCommitArtifactsDetail(cwd) {
  const fromConfig = readConfigCommitArtifacts(cwd);
  if (fromConfig !== null) {
    return { enabled: fromConfig, source: 'config' };
  }
  return { enabled: DEFAULT_COMMIT_ARTIFACTS, source: 'default' };
}

module.exports = {
  DEFAULT_COMMIT_ARTIFACTS,
  readConfigCommitArtifacts,
  resolveCommitArtifacts,
  resolveCommitArtifactsDetail,
};

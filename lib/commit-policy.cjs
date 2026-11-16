'use strict';


const { readConfigGraceful, coerceBool } = require('./config.cjs');
const { DEFAULT_WORKFLOW } = require('./config-defaults.cjs');

const DEFAULT_COMMIT_ARTIFACTS = DEFAULT_WORKFLOW.commit_artifacts;

function readConfigCommitArtifacts(cwd) {
  const parsed = readConfigGraceful(cwd, 'commit-policy-config-parse-error');
  if (!parsed) return null;
  const workflow = parsed.workflow;
  if (!workflow || typeof workflow !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(workflow, 'commit_artifacts')) return null;
  return coerceBool(workflow.commit_artifacts);
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

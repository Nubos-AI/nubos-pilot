'use strict';

const DEFAULT_WORKFLOW = Object.freeze({
  commit_docs: true,
  commit_artifacts: true,
});

const DEFAULT_AGENTS = Object.freeze({
  parallelization: true,
  research: true,
  plan_checker: true,
  verifier: true,
});

const DEFAULT_MODEL_PROFILE = 'frontier';
const DEFAULT_SCOPE = 'local';
const DEFAULT_RESPONSE_LANGUAGE = 'en';

function buildInstallConfig(answers) {
  const a = answers || {};
  return {
    runtime: a.runtime || null,
    runtimes: Array.isArray(a.runtimes) ? a.runtimes.slice() : (a.runtime ? [a.runtime] : []),
    scope: a.scope || DEFAULT_SCOPE,
    mcp: !!a.mcp,
    model_profile: a.model_profile || DEFAULT_MODEL_PROFILE,
    response_language: a.response_language || DEFAULT_RESPONSE_LANGUAGE,
    workflow: { ...DEFAULT_WORKFLOW },
    agents: { ...DEFAULT_AGENTS },
  };
}

module.exports = {
  DEFAULT_WORKFLOW,
  DEFAULT_AGENTS,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SCOPE,
  DEFAULT_RESPONSE_LANGUAGE,
  buildInstallConfig,
};

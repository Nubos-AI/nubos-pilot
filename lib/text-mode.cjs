'use strict';

const { readConfigGraceful, coerceBool } = require('./config.cjs');

const DEFAULT_TEXT_MODE = false;
const CLAUDE_ENV_KEYS = [];

function readConfigTextMode(cwd) {
  const parsed = readConfigGraceful(cwd, 'text-mode-config-parse-error');
  if (!parsed) return null;
  const workflow = parsed.workflow;
  if (!workflow || typeof workflow !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(workflow, 'text_mode')) return null;
  return coerceBool(workflow.text_mode);
}

function detectRuntimeTextMode(env) {
  const source = env || process.env;
  for (const key of CLAUDE_ENV_KEYS) {
    const v = source[key];
    if (v != null && String(v) !== '' && String(v) !== '0' && String(v).toLowerCase() !== 'false') {
      return true;
    }
  }
  return false;
}

function resolveTextMode(cwd, env) {
  const fromConfig = readConfigTextMode(cwd);
  if (fromConfig !== null) return fromConfig;
  if (detectRuntimeTextMode(env)) return true;
  return DEFAULT_TEXT_MODE;
}

function resolveTextModeDetail(cwd, env) {
  const fromConfig = readConfigTextMode(cwd);
  if (fromConfig !== null) {
    return { enabled: fromConfig, source: 'config' };
  }
  if (detectRuntimeTextMode(env)) {
    return { enabled: true, source: 'runtime' };
  }
  return { enabled: DEFAULT_TEXT_MODE, source: 'default' };
}

module.exports = {
  DEFAULT_TEXT_MODE,
  CLAUDE_ENV_KEYS,
  readConfigTextMode,
  detectRuntimeTextMode,
  resolveTextMode,
  resolveTextModeDetail,
};

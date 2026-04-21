'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot, NubosPilotError } = require('./core.cjs');

const DEFAULT_TEXT_MODE = false;
const CLAUDE_ENV_KEYS = [];

function _coerceBool(raw) {
  if (raw === true || raw === false) return raw;
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function readConfigTextMode(cwd) {
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
    throw new NubosPilotError('text-mode-config-parse-error', 'config.json invalid JSON', { cause: err && err.message });
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const workflow = parsed.workflow;
  if (!workflow || typeof workflow !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(workflow, 'text_mode')) return null;
  const coerced = _coerceBool(workflow.text_mode);
  return coerced;
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

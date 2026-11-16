'use strict';

const { NubosPilotError } = require('../core.cjs');
const { tryReadConfigPath } = require('../config.cjs');
const { getRuntime: _askuserGetRuntime } = require('../askuser.cjs');

const KNOWN_RUNTIMES = [
  'claude', 'antigravity', 'augment', 'cline', 'codebuddy',
  'codex', 'copilot', 'cursor', 'gemini', 'kilo',
  'opencode', 'qwen', 'trae', 'windsurf',
];

function listRuntimes() {
  return KNOWN_RUNTIMES.slice();
}

function getAdapter(name) {
  if (!KNOWN_RUNTIMES.includes(name)) {
    throw new NubosPilotError(
      'runtime-unknown',
      'Unknown runtime: ' + name,
      { name, known: KNOWN_RUNTIMES.slice() },
    );
  }
  return require('./' + name + '.cjs');
}

function detect(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();

  const configured = tryReadConfigPath(cwd, 'runtime', null);
  if (configured && KNOWN_RUNTIMES.includes(configured)) {
    const source = tryReadConfigPath(cwd, 'runtime_source', null) || 'config';
    return { runtime: configured, source };
  }

  const live = _askuserGetRuntime();
  if (KNOWN_RUNTIMES.includes(live)) {
    return { runtime: live, source: 'env' };
  }

  return { runtime: 'codex', source: 'default' };
}

function getCurrent() {
  const { runtime } = detect();
  return getAdapter(runtime);
}

module.exports = { listRuntimes, getAdapter, getCurrent, detect };

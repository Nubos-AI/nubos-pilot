const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../core.cjs');
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

  const configPath = path.join(cwd, '.nubos-pilot', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg && cfg.runtime && KNOWN_RUNTIMES.includes(cfg.runtime)) {
        return { runtime: cfg.runtime, source: cfg.runtime_source || 'config' };
      }
    } catch {  }
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

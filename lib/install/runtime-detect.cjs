const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detect: runtimeDetect } = require('../runtime/index.cjs');

const DEFAULT_PATH_PROBES = ['claude', 'codex', 'gemini'];

function _defaultPathProbe(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return bin;
  } catch {
    return null;
  }
}

function detectRuntime(opts) {
  const options = opts || {};
  const cwd = options.cwd || process.cwd();
  const pathProbe =
    typeof options.pathProbe === 'function' ? options.pathProbe : _defaultPathProbe;

  const primary = runtimeDetect({ cwd });
  if (primary && primary.source !== 'default') {
    return primary;
  }

  for (const bin of DEFAULT_PATH_PROBES) {
    let hit = null;
    try { hit = pathProbe(bin); } catch { hit = null; }
    if (hit) return { runtime: bin, source: 'path' };
  }

  if (fs.existsSync(path.join(cwd, '.claude'))) {
    return { runtime: 'claude', source: 'disk' };
  }
  if (fs.existsSync(path.join(cwd, '.codex'))) {
    return { runtime: 'codex', source: 'disk' };
  }

  return { runtime: 'generic-readline', source: 'default' };
}

module.exports = { detectRuntime };

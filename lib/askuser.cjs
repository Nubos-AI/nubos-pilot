let _runtime = null;

function _detectRuntime() {
  const env = process.env;
  if (env.NUBOS_RUNTIME) return String(env.NUBOS_RUNTIME);
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.CODEX_HOME || env.CODEX_VERSION) return 'codex';
  if (env.GEMINI_CLI || env.GEMINI_VERSION) return 'gemini';
  if (env.OPENCODE || env.OPENCODE_VERSION) return 'opencode';
  return 'generic-readline';
}

function getRuntime() {
  if (_runtime === null || process.env.NUBOS_PILOT_REDETECT_RUNTIME === '1') {
    _runtime = _detectRuntime();
  }
  return _runtime;
}

function _setReadlineImplForTests(impl) {
  const rl = require('./runtime/_readline.cjs');
  rl._setReadlineImplForTests(impl);
}

async function askUser(spec) {
  const { getCurrent } = require('./runtime/index.cjs');
  const adapter = getCurrent();
  return adapter.askUser(spec);
}

module.exports = {
  askUser,
  getRuntime,
  _detectRuntime,
  _setReadlineImplForTests,
};

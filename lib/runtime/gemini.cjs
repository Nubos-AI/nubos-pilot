const { askUserReadline } = require('./_readline.cjs');

async function askUser(spec) {
  return askUserReadline({
    type: spec && spec.type,
    question: spec && spec.question,
    options: spec && spec.options,
    def: spec ? spec.default : undefined,
  });
}

module.exports = {
  name: 'gemini',
  detectHints: {
    env: ['GEMINI_CLI', 'GEMINI_VERSION'],
    pathBinary: 'gemini',
    diskMarkers: ['.gemini/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'GEMINI.md',
    textMode: 'auto',
    modelResolution: 'profile',
  },
  paths: {
    payload: null,
    config: null,
    agentsMd: 'GEMINI.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (GEMINI.md) wird von der Gemini CLI konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
  askUser,
};

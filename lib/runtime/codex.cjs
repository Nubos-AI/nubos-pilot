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
  name: 'codex',
  detectHints: {
    env: ['CODEX_HOME', 'CODEX_VERSION'],
    pathBinary: 'codex',
    diskMarkers: ['.codex/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'profile',
  },
  paths: {
    payload: null,
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Codex/Gemini/OpenCode konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr), nicht über das Claude-spezifische AskUser-Tool.',
  askUser,
};

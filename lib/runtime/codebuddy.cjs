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
  name: 'codebuddy',
  detectHints: {
    env: ['CODEBUDDY_CONFIG_DIR'],
    pathBinary: 'codebuddy',
    diskMarkers: ['.codebuddy/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.codebuddy/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von CodeBuddy konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
  askUser,
};

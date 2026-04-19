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
  name: 'cline',
  detectHints: {
    env: ['CLINE_CONFIG_DIR'],
    pathBinary: 'cline',
    diskMarkers: ['.clinerules'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: '.clinerules',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.clinerules-nubos-pilot/',
    config: null,
    agentsMd: '.clinerules',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (.clinerules) wird von Cline konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
  askUser,
};

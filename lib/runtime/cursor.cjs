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
  name: 'cursor',
  detectHints: {
    env: ['CURSOR_CONFIG_DIR'],
    pathBinary: 'cursor',
    diskMarkers: ['.cursor/', '.cursorrules'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'rules/nubos-pilot.mdc',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.cursor/nubos-pilot/',
    config: null,
    agentsMd: '.cursor/rules/nubos-pilot.mdc',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (.cursor/rules/nubos-pilot.mdc) wird von Cursor konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
  askUser,
};

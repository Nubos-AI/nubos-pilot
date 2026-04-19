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
  name: 'windsurf',
  detectHints: {
    env: ['WINDSURF_CONFIG_DIR'],
    pathBinary: 'windsurf',
    diskMarkers: ['.windsurf/', '.windsurfrules', '.codeium/windsurf/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: '.windsurfrules',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.windsurf-nubos-pilot/',
    config: null,
    agentsMd: '.windsurfrules',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (.windsurfrules) wird von Windsurf konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
  askUser,
};

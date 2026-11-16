'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'copilot',
  detectHints: {
    env: ['COPILOT_CONFIG_DIR'],
    pathBinary: 'copilot',
    diskMarkers: ['.github/copilot-instructions.md', '.copilot/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'copilot-instructions.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.github/nubos-pilot/',
    config: null,
    agentsMd: '.github/copilot-instructions.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (.github/copilot-instructions.md) wird von GitHub Copilot konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

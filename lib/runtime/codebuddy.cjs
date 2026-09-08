'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
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
});

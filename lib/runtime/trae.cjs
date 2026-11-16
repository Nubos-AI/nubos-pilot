'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'trae',
  detectHints: {
    env: ['TRAE_CONFIG_DIR'],
    pathBinary: 'trae',
    diskMarkers: ['.trae/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.trae/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Trae konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

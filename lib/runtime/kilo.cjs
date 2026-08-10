'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'kilo',
  detectHints: {
    env: ['KILO_CONFIG_DIR'],
    pathBinary: 'kilo',
    diskMarkers: ['.kilo/', '.config/kilo/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.kilo/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Kilo konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

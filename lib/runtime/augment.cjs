'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'augment',
  detectHints: {
    env: ['AUGMENT_CONFIG_DIR'],
    pathBinary: 'augment',
    diskMarkers: ['.augment/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.augment/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Augment konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
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
});

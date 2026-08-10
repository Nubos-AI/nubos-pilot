'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
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
});

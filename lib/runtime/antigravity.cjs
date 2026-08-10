'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'antigravity',
  detectHints: {
    env: ['ANTIGRAVITY_CONFIG_DIR'],
    pathBinary: 'antigravity',
    diskMarkers: ['.agent/', '.gemini/antigravity/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.agent/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Antigravity konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

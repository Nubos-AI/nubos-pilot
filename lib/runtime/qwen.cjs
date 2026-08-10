'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'qwen',
  detectHints: {
    env: ['QWEN_CONFIG_DIR'],
    pathBinary: 'qwen',
    diskMarkers: ['.qwen/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.qwen/nubos-pilot/',
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Qwen Code konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr).',
});

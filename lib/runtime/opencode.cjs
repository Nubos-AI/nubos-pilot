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
  name: 'opencode',
  detectHints: {
    env: ['OPENCODE', 'OPENCODE_VERSION'],
    pathBinary: 'opencode',
    diskMarkers: ['.opencode/', 'opencode.json'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'inherit',
  },
  paths: {
    payload: '.opencode/nubos-pilot/',
    config: 'opencode.json',
    agentsMd: '.opencode/nubos-pilot/AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei (.opencode/nubos-pilot/AGENTS.md) wird von OpenCode konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr); Subagents erben das Modell vom Caller (`/model inherit`).',
  askUser,
};

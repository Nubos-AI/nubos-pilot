'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'codex',
  detectHints: {
    env: ['CODEX_HOME', 'CODEX_VERSION'],
    pathBinary: 'codex',
    diskMarkers: ['.codex/'],
  },
  capabilities: {
    askUserQuestion: false,
    // Skills, not prompts: Codex loads custom prompts only from
    // $CODEX_HOME/prompts (user-global, deprecated), while `.codex/skills/` is
    // project-scoped. So the workflows do get an invocable command surface —
    // but as `$np-plan-phase`, not `/np:plan-phase`. `commandSurface` carries
    // that difference; `slashCommands` stays the boolean the contract requires.
    slashCommands: true,
    commandSurface: 'skills',
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'profile',
  },
  paths: {
    payload: '.codex/nubos-pilot',
    config: '.codex',
    skills: '.codex/skills',
    agents: '.codex/agents',
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Codex/Gemini/OpenCode konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr), nicht über das Claude-spezifische AskUser-Tool. '
    + 'In Codex liegen die nubos-pilot-Workflows als Skills unter `.codex/skills/` und werden mit '
    + '`$np-<name>` aufgerufen (z. B. `$np-plan-phase 1`) — nicht mit `/np:<name>`; `/skills` listet sie auf. '
    + 'Die Loop-Rollen (np-planner, np-critic, np-verifier …) liegen als Subagents unter `.codex/agents/` '
    + 'und werden per Delegation gespawnt, also in eigenen Threads mit eigenem Kontext.',
});

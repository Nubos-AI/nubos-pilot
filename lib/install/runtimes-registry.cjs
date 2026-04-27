'use strict';

const os = require('node:os');
const path = require('node:path');

const RUNTIMES = [
  {
    id: 'claude',
    label: 'Claude Code',
    localDir: '.claude',
    globalDir: ['.claude'],
    envConfigDir: 'CLAUDE_CONFIG_DIR',
    agentsMd: 'CLAUDE.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
    commandsSubdir: 'commands/np',
    agentsSubdir: 'agents',
    skillsSubdir: 'skills',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    localDir: '.agent',
    globalDir: ['.gemini', 'antigravity'],
    envConfigDir: 'ANTIGRAVITY_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'augment',
    label: 'Augment',
    localDir: '.augment',
    globalDir: ['.augment'],
    envConfigDir: 'AUGMENT_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'cline',
    label: 'Cline',
    localDir: '.',
    globalDir: ['.cline'],
    envConfigDir: 'CLINE_CONFIG_DIR',
    agentsMd: '.clinerules',
    agentsMdScope: 'project',
    payloadSubdir: '.clinerules-nubos-pilot',
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    localDir: '.codebuddy',
    globalDir: ['.codebuddy'],
    envConfigDir: 'CODEBUDDY_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'codex',
    label: 'Codex',
    localDir: '.codex',
    globalDir: ['.codex'],
    envConfigDir: 'CODEX_HOME',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'copilot',
    label: 'Copilot',
    localDir: '.github',
    globalDir: ['.copilot'],
    envConfigDir: 'COPILOT_CONFIG_DIR',
    agentsMd: 'copilot-instructions.md',
    agentsMdScope: 'dir',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    localDir: '.cursor',
    globalDir: ['.cursor'],
    envConfigDir: 'CURSOR_CONFIG_DIR',
    agentsMd: 'rules/nubos-pilot.mdc',
    agentsMdScope: 'dir',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    localDir: '.gemini',
    globalDir: ['.gemini'],
    envConfigDir: 'GEMINI_CONFIG_DIR',
    agentsMd: 'GEMINI.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'kilo',
    label: 'Kilo',
    localDir: '.kilo',
    globalDir: ['.config', 'kilo'],
    envConfigDir: 'KILO_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    localDir: '.opencode',
    globalDir: ['.config', 'opencode'],
    envConfigDir: 'OPENCODE_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'dir',
    payloadSubdir: 'nubos-pilot',
    commandsSubdir: 'command/np',
    agentsSubdir: 'agent',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    localDir: '.qwen',
    globalDir: ['.qwen'],
    envConfigDir: 'QWEN_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'trae',
    label: 'Trae',
    localDir: '.trae',
    globalDir: ['.trae'],
    envConfigDir: 'TRAE_CONFIG_DIR',
    agentsMd: 'AGENTS.md',
    agentsMdScope: 'project',
    payloadSubdir: 'nubos-pilot',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    localDir: '.windsurf',
    globalDir: ['.codeium', 'windsurf'],
    envConfigDir: 'WINDSURF_CONFIG_DIR',
    agentsMd: '.windsurfrules',
    agentsMdScope: 'project',
    payloadSubdir: '.windsurf-nubos-pilot',
  },
];

const RUNTIME_INDEX = new Map(RUNTIMES.map((r) => [r.id, r]));

function listRuntimeIds() {
  return RUNTIMES.map((r) => r.id);
}

function getRuntimeMeta(id) {
  return RUNTIME_INDEX.get(id) || null;
}

function runtimeGlobalDir(meta) {
  if (meta.envConfigDir && process.env[meta.envConfigDir]) {
    const v = process.env[meta.envConfigDir];
    return v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v;
  }
  return path.join(os.homedir(), ...(meta.globalDir || [meta.localDir]));
}

function runtimeLocalDir(meta, projectRoot) {
  return path.join(projectRoot, meta.localDir || '.');
}

function runtimeConfigDir(meta, scope, projectRoot) {
  return scope === 'global'
    ? runtimeGlobalDir(meta)
    : runtimeLocalDir(meta, projectRoot);
}

function runtimePayloadDir(meta, scope, projectRoot) {
  return path.join(runtimeConfigDir(meta, scope, projectRoot), meta.payloadSubdir);
}

function runtimeAgentsPath(meta, scope, projectRoot) {
  if (meta.agentsMdScope === 'dir') {
    return path.join(runtimeConfigDir(meta, scope, projectRoot), meta.agentsMd);
  }
  return path.join(projectRoot, meta.agentsMd);
}

module.exports = {
  RUNTIMES,
  listRuntimeIds,
  getRuntimeMeta,
  runtimeGlobalDir,
  runtimeLocalDir,
  runtimeConfigDir,
  runtimePayloadDir,
  runtimeAgentsPath,
};

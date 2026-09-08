'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter, stripFrontmatter } = require('./frontmatter.cjs');
const { NubosPilotError, findProjectRoot } = require('./core.cjs');

const REQUIRED = ['name', 'description', 'tier', 'tools'];
const TIER_ENUM = ['haiku', 'sonnet', 'opus'];
const FORBIDDEN = ['model', 'model_profile', 'hooks'];

function _forbiddenHint(field) {
  if (field === 'model') return 'Use "tier" instead.';
  if (field === 'model_profile') return 'Use "tier" instead.';
  return 'hooks are runtime-specific and deferred to Phase 7/8.';
}

function validateAgentFrontmatter(fm, agentName) {
  for (const f of REQUIRED) {
    if (!fm[f]) {
      throw new NubosPilotError(
        'agent-invalid-frontmatter',
        'Agent "' + agentName + '" missing required frontmatter field: ' + f,
        { field: f, agent: agentName },
      );
    }
  }
  for (const f of FORBIDDEN) {
    if (fm[f] !== undefined) {
      throw new NubosPilotError(
        'agent-forbidden-field',
        'Agent "' + agentName + '" uses forbidden frontmatter field: ' + f,
        { field: f, agent: agentName, hint: _forbiddenHint(f) },
      );
    }
  }
  if (!TIER_ENUM.includes(fm.tier)) {
    throw new NubosPilotError(
      'agent-invalid-tier',
      'Agent "' + agentName + '" has invalid tier: ' + fm.tier,
      { agent: agentName, value: fm.tier, allowed: TIER_ENUM.slice() },
    );
  }
  if (fm.name !== agentName) {
    throw new NubosPilotError(
      'agent-invalid-frontmatter',
      'Agent filename "' + agentName + '" does not match frontmatter name "' + fm.name + '"',
      { field: 'name', agent: agentName, expected: agentName, got: fm.name },
    );
  }
  if (fm.module !== undefined && fm.module !== true) {
    throw new NubosPilotError(
      'agent-invalid-frontmatter',
      'Agent "' + agentName + '" has invalid module value: must be exactly boolean true if present',
      { field: 'module', agent: agentName, expected: true, got: fm.module },
    );
  }
  return fm;
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function _resolveAgentPath(name, cwd) {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new NubosPilotError(
      'agent-invalid-name',
      'Agent name must match /^[a-zA-Z0-9_-]+$/ (no slashes, no dots, no traversal)',
      { name: typeof name === 'string' ? name.slice(0, 80) : typeof name } ,
    );
  }
  const candidates = [];
  try {
    const root = findProjectRoot(cwd || process.cwd());
    candidates.push(path.join(root, 'agents', name + '.md'));
  } catch {}
  candidates.push(path.resolve(__dirname, '..', 'agents', name + '.md'));

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new NubosPilotError(
      'agent-not-found',
      'Agent "' + name + '" not found at ' + candidates[0],
      { name, path: candidates[0], tried: candidates },
    );
  }
  return found;
}

function _loadAgentFromDisk(name, cwd) {
  const found = _resolveAgentPath(name, cwd);
  const { frontmatter } = extractFrontmatter(fs.readFileSync(found, 'utf-8'));
  return validateAgentFrontmatter(frontmatter, name);
}

function loadAgentSource(name, cwd) {
  const found = _resolveAgentPath(name, cwd);
  const raw = fs.readFileSync(found, 'utf-8');
  const { frontmatter } = extractFrontmatter(raw);
  validateAgentFrontmatter(frontmatter, name);
  return { frontmatter, body: stripFrontmatter(raw), path: found };
}

function loadAgent(name, cwd) {
  const fm = _loadAgentFromDisk(name, cwd);
  if (fm.module === true) {
    throw new NubosPilotError(
      'agent-not-spawnable',
      'Agent "' + name + '" is a module (module: true) and cannot be spawned directly',
      {
        agent: name,
        hint: 'Modules are loaded as <files_to_read> by their parent agent. Use loadAgentModule() to read module frontmatter.',
      },
    );
  }
  return fm;
}

function loadAgentModule(name, cwd) {
  const fm = _loadAgentFromDisk(name, cwd);
  if (fm.module !== true) {
    throw new NubosPilotError(
      'agent-not-a-module',
      'Agent "' + name + '" is not a module (missing module: true) and cannot be loaded as one',
      {
        agent: name,
        hint: 'Spawnable agents are loaded via loadAgent().',
      },
    );
  }
  return fm;
}

function listAgents(cwd) {
  const root = findProjectRoot(cwd || process.cwd());
  const dir = path.join(root, 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

function getAgentSkills(name, cwd) {
  let config;
  try {
    config = require('./config.cjs').readConfig(cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return [];
    throw err;
  }
  const skills = config && config.agent_skills && config.agent_skills[name];
  return Array.isArray(skills) ? skills : [];
}

module.exports = {
  validateAgentFrontmatter,
  loadAgent,
  loadAgentModule,
  loadAgentSource,
  listAgents,
  getAgentSkills,
  AGENT_NAME_RE,
  TIER_ENUM,
  REQUIRED,
  FORBIDDEN,
};

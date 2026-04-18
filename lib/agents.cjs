const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');
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
  return fm;
}

function loadAgent(name, cwd) {
  const root = findProjectRoot(cwd || process.cwd());
  const p = path.join(root, 'agents', name + '.md');
  if (!fs.existsSync(p)) {
    throw new NubosPilotError(
      'agent-not-found',
      'Agent "' + name + '" not found at ' + p,
      { name, path: p },
    );
  }
  const { frontmatter } = extractFrontmatter(fs.readFileSync(p, 'utf-8'));
  return validateAgentFrontmatter(frontmatter, name);
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
  const root = findProjectRoot(cwd || process.cwd());
  const configPath = path.join(root, '.nubos-pilot', 'config.json');
  if (!fs.existsSync(configPath)) return [];
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return [];
  }
  const skills = config && config.agent_skills && config.agent_skills[name];
  return Array.isArray(skills) ? skills : [];
}

module.exports = {
  validateAgentFrontmatter,
  loadAgent,
  listAgents,
  getAgentSkills,
  TIER_ENUM,
  REQUIRED,
  FORBIDDEN,
};

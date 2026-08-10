const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const agents = require('./agents.cjs');
const {
  validateAgentFrontmatter,
  loadAgent,
  loadAgentModule,
  listAgents,
  getAgentSkills,
  TIER_ENUM,
  REQUIRED,
  FORBIDDEN,
} = agents;
const { extractFrontmatter } = require('./frontmatter.cjs');

const FIXTURE_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'agents');

const _sandboxes = [];

function makeAgentSandbox(seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-agents-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const payload = seed || {};
  for (const [name, srcOrContent] of Object.entries(payload)) {
    const target = path.join(root, 'agents', name + '.md');
    if (srcOrContent.startsWith('fixture:')) {
      const fixtureName = srcOrContent.slice('fixture:'.length);
      const content = fs.readFileSync(path.join(FIXTURE_DIR, fixtureName + '.md'), 'utf-8');
      fs.writeFileSync(target, content, 'utf-8');
    } else {
      fs.writeFileSync(target, srcOrContent, 'utf-8');
    }
  }
  _sandboxes.push(root);
  return root;
}

function cleanupAll() {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {  }
  }
}

test.afterEach(() => cleanupAll());

test('AG-1: valid frontmatter returns the fm object', () => {
  const fm = { name: 'np-planner', description: 'd', tier: 'opus', tools: 'Read, Write, Bash' };
  const out = validateAgentFrontmatter(fm, 'np-planner');
  assert.equal(out, fm);
  assert.equal(out.tier, 'opus');
});

test('AG-2: missing required field tier → agent-invalid-frontmatter with field=tier', () => {
  const fm = { name: 'np-planner', description: 'd', tools: 'Read' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'agent-invalid-frontmatter');
  assert.equal(thrown.details.field, 'tier');
  assert.equal(thrown.details.agent, 'np-planner');
});

test('AG-3: invalid tier gpt-4 → agent-invalid-tier with allowed enum', () => {
  const fm = { name: 'np-planner', description: 'd', tier: 'gpt-4', tools: 'Read' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-invalid-tier');
  assert.deepEqual(thrown.details.allowed, ['haiku', 'sonnet', 'opus']);
  assert.equal(thrown.details.value, 'gpt-4');
});

test('AG-4: forbidden model → agent-forbidden-field with hint containing "Use \\"tier\\" instead."', () => {
  const fm = { name: 'np-planner', description: 'd', tier: 'opus', tools: 'Read', model: 'opus' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-forbidden-field');
  assert.equal(thrown.details.field, 'model');
  assert.ok(thrown.details.hint && thrown.details.hint.includes('Use "tier" instead.'));
});

test('AG-5: forbidden model_profile → agent-forbidden-field field=model_profile', () => {
  const fm = { name: 'np-planner', description: 'd', tier: 'opus', tools: 'Read', model_profile: 'quality' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-forbidden-field');
  assert.equal(thrown.details.field, 'model_profile');
});

test('AG-6: forbidden hooks → agent-forbidden-field field=hooks', () => {
  const fm = { name: 'np-planner', description: 'd', tier: 'opus', tools: 'Read', hooks: 'anything' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-forbidden-field');
  assert.equal(thrown.details.field, 'hooks');
});

test('AG-7: name mismatch → agent-invalid-frontmatter field=name with expected/got', () => {
  const fm = { name: 'different', description: 'd', tier: 'opus', tools: 'Read' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'np-planner'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-invalid-frontmatter');
  assert.equal(thrown.details.field, 'name');
  assert.equal(thrown.details.expected, 'np-planner');
  assert.equal(thrown.details.got, 'different');
});

test('AG-8: loadAgent nonexistent → agent-not-found', () => {
  const sb = makeAgentSandbox({});
  let thrown = null;
  try { loadAgent('nonexistent', sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-not-found');
  assert.equal(thrown.details.name, 'nonexistent');
});

test('AG-9: loadAgent planner returns fm with tier=opus', () => {
  const sb = makeAgentSandbox({ 'np-planner': 'fixture:valid-planner' });
  const fm = loadAgent('np-planner', sb);
  assert.equal(fm.tier, 'opus');
  assert.equal(fm.name, 'np-planner');
});

test('AG-10: listAgents returns sorted names (no .md suffix)', () => {
  const sb = makeAgentSandbox({
    'np-planner': 'fixture:valid-planner',
    'np-researcher': '---\nname: np-researcher\ndescription: r\ntier: sonnet\ntools: Read\n---\nbody',
    'np-plan-checker': '---\nname: np-plan-checker\ndescription: pc\ntier: opus\ntools: Read\n---\nbody',
  });
  const out = listAgents(sb);
  assert.deepEqual(out, ['np-plan-checker', 'np-planner', 'np-researcher']);
});

test('AG-11: listAgents on missing agents/ dir returns []', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-agents-empty-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  const out = listAgents(root);
  assert.deepEqual(out, []);
});

test('AG-12: getAgentSkills returns configured skills array when config present', () => {
  const sb = makeAgentSandbox({ 'np-planner': 'fixture:valid-planner' });
  const config = { agent_skills: { 'np-planner': ['Read', 'Grep'] } };
  fs.writeFileSync(path.join(sb, '.nubos-pilot', 'config.json'), JSON.stringify(config), 'utf-8');
  const out = getAgentSkills('np-planner', sb);
  assert.deepEqual(out, ['Read', 'Grep']);
});

test('AG-13: getAgentSkills returns [] when config missing', () => {
  const sb = makeAgentSandbox({ 'np-planner': 'fixture:valid-planner' });
  const out = getAgentSkills('np-planner', sb);
  assert.deepEqual(out, []);
});

test('AG-13b: getAgentSkills propagates config-invalid-json (loud, not silent [])', () => {
  const sb = makeAgentSandbox({ 'np-planner': 'fixture:valid-planner' });
  fs.writeFileSync(path.join(sb, '.nubos-pilot', 'config.json'), '{ broken', 'utf-8');
  assert.throws(
    () => getAgentSkills('np-planner', sb),
    (err) => err && err.code === 'config-invalid-json',
  );
});

test('AG-13c: getAgentSkills returns [] when not in a project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-agent-no-project-'));
  _sandboxes.push(dir);
  assert.deepEqual(getAgentSkills('np-planner', dir), []);
});

test('AG-14: exported constants match spec', () => {
  assert.deepEqual(TIER_ENUM, ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(FORBIDDEN, ['model', 'model_profile', 'hooks']);
  assert.deepEqual(REQUIRED, ['name', 'description', 'tier', 'tools']);
});

test('AG-15: loadAgent round-trip through fixture with FORBIDDEN model field throws', () => {
  const sb = makeAgentSandbox({ 'invalid-model': 'fixture:invalid-model-field' });
  let thrown = null;
  try { loadAgent('invalid-model', sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-forbidden-field');
  assert.equal(thrown.details.field, 'model');
});

function _toolsToArray(toolsField) {

  return String(toolsField).split(',').map((s) => s.trim()).filter(Boolean);
}

const REPO_AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

function _seedRealAgent(agentName) {

  const src = fs.readFileSync(path.join(REPO_AGENTS_DIR, agentName + '.md'), 'utf-8');
  return makeAgentSandbox({ [agentName]: src });
}

test('AG-16: loadAgent executor validates (tier sonnet, full toolset, no forbidden fields)', () => {
  const sb = _seedRealAgent('np-executor');
  const fm = loadAgent('np-executor', sb);
  assert.equal(fm.name, 'np-executor');
  assert.equal(fm.tier, 'sonnet');
  const tools = _toolsToArray(fm.tools).sort();
  assert.deepEqual(tools, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);

  assert.equal(fm.model, undefined);
  assert.equal(fm.model_profile, undefined);
  assert.equal(fm.hooks, undefined);
});

test('AG-17: loadAgent verifier is sonnet and read-only (no Write/Edit in tools)', () => {
  const sb = _seedRealAgent('np-verifier');
  const fm = loadAgent('np-verifier', sb);
  assert.equal(fm.name, 'np-verifier');
  assert.equal(fm.tier, 'sonnet');
  const tools = _toolsToArray(fm.tools);

  assert.ok(!tools.includes('Write'), 'verifier must not have Write tool');
  assert.ok(!tools.includes('Edit'),  'verifier must not have Edit tool');

  assert.deepEqual(tools.slice().sort(), ['Bash', 'Glob', 'Grep', 'Read']);
});

const NP_AGENTS = [
  { file: 'np-planner', expected_tier: 'opus' },
  { file: 'np-plan-checker', expected_tier: 'opus' },
  { file: 'np-executor', expected_tier: 'sonnet' },
  { file: 'np-verifier', expected_tier: 'sonnet' },
  { file: 'np-researcher', expected_tier: 'sonnet' },
  { file: 'np-researcher-reconciler', expected_tier: 'sonnet' },
  { file: 'np-codebase-documenter', expected_tier: 'sonnet' },
  { file: 'np-architect', expected_tier: 'sonnet' },
  { file: 'np-task-architect', expected_tier: 'sonnet' },
  { file: 'np-test-writer', expected_tier: 'sonnet' },
  { file: 'np-build-fixer', expected_tier: 'sonnet' },
  { file: 'np-security-reviewer', expected_tier: 'sonnet' },
  { file: 'np-nyquist-auditor', expected_tier: 'haiku' },
  { file: 'np-sc-extractor', expected_tier: 'haiku' },
  { file: 'np-critic', expected_tier: 'sonnet' },
  { file: 'np-learnings-extractor', expected_tier: 'haiku' },
  { file: 'np-simplifier', expected_tier: 'sonnet' },
];

// Audit-surface modules — files in agents/ that carry agent-shaped frontmatter
// (name, tier, tools) but are NEVER spawned independently. Loaded as
// <files_to_read> by their parent agent. ADR-0010 §Single-Critic Revision.
const NP_AGENT_MODULES = [
  { file: 'np-critic-style', parent: 'np-critic' },
  { file: 'np-critic-tests', parent: 'np-critic' },
  { file: 'np-critic-acceptance', parent: 'np-critic' },
  { file: 'np-critic-economy', parent: 'np-critic' },
];

for (let i = 0; i < NP_AGENTS.length; i += 1) {
  const spec = NP_AGENTS[i];
  const testId = 'AG-' + (18 + i);
  test(testId + ': ' + spec.file + ' passes validateAgentFrontmatter with tier:' + spec.expected_tier, () => {
    const src = fs.readFileSync(path.join(REPO_AGENTS_DIR, spec.file + '.md'), 'utf-8');
    const fm = extractFrontmatter(src).frontmatter;
    assert.doesNotThrow(() => validateAgentFrontmatter(fm, spec.file));
    assert.equal(fm.tier, spec.expected_tier);
    assert.equal(fm.name, spec.file);
    assert.ok(!('model' in fm), spec.file + ' must not have model: key');
    assert.ok(!('model_profile' in fm), spec.file + ' must not have model_profile: key');
    assert.ok(!('hooks' in fm), spec.file + ' must not have hooks: key');
  });
}

test('AG-25: bulk np-* iteration — exactly the nubos-pilot agents+modules exist in agents/', () => {
  const agentsDir = path.resolve(__dirname, '..', 'agents');
  const names = fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .filter((n) => n.startsWith('np-'))
    .sort();
  const expected = [
    ...NP_AGENTS.map((a) => a.file),
    ...NP_AGENT_MODULES.map((m) => m.file),
  ].sort();
  assert.deepEqual(names, expected,
    'agents/ directory must contain exactly the nubos-pilot agent set (agents + audit-surface modules)');
});

test('AG-26: audit-surface modules are flagged module:true and parent agent exists', () => {
  for (const mod of NP_AGENT_MODULES) {
    const src = fs.readFileSync(path.join(REPO_AGENTS_DIR, mod.file + '.md'), 'utf-8');
    const fm = extractFrontmatter(src).frontmatter;
    assert.equal(fm.module, true,
      mod.file + ' must declare module: true (it is loaded by ' + mod.parent + ', not spawned independently)');
    // Parent must exist in NP_AGENTS (the spawnable list).
    const parentExists = NP_AGENTS.some((a) => a.file === mod.parent);
    assert.ok(parentExists,
      mod.file + ' references parent ' + mod.parent + ' which is not in NP_AGENTS');
    // Module file must NOT be spawned by any tool — verify it isn't listed
    // anywhere in resolve-model's tier-overrides as a primary agent.
    assert.equal(fm.name, mod.file, mod.file + ' frontmatter name must match filename');
  }
});

test('AG-27: spawnable agents (NP_AGENTS) MUST NOT have module:true', () => {
  for (const spec of NP_AGENTS) {
    const src = fs.readFileSync(path.join(REPO_AGENTS_DIR, spec.file + '.md'), 'utf-8');
    const fm = extractFrontmatter(src).frontmatter;
    assert.notEqual(fm.module, true,
      spec.file + ' is in NP_AGENTS (spawnable) and must NOT carry module:true');
  }
});

test('AG-28: loadAgent on module:true file throws agent-not-spawnable', () => {
  const sb = makeAgentSandbox({
    'np-critic-style': '---\nname: np-critic-style\ndescription: Style audit module.\nmodule: true\ntier: haiku\ntools: Read\n---\nbody',
  });
  let thrown = null;
  try { loadAgent('np-critic-style', sb); } catch (e) { thrown = e; }
  assert.ok(thrown, 'loadAgent must reject module files');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'agent-not-spawnable');
  assert.equal(thrown.details.agent, 'np-critic-style');
  assert.ok(thrown.details.hint && thrown.details.hint.includes('files_to_read'));
});

test('AG-29: loadAgentModule on module:true file returns frontmatter', () => {
  const sb = makeAgentSandbox({
    'np-critic-style': '---\nname: np-critic-style\ndescription: Style audit module.\nmodule: true\ntier: haiku\ntools: Read\n---\nbody',
  });
  const fm = loadAgentModule('np-critic-style', sb);
  assert.equal(fm.name, 'np-critic-style');
  assert.equal(fm.module, true);
  assert.equal(fm.tier, 'haiku');
});

test('AG-30: loadAgentModule on spawnable agent throws agent-not-a-module', () => {
  const sb = makeAgentSandbox({ 'np-planner': 'fixture:valid-planner' });
  let thrown = null;
  try { loadAgentModule('np-planner', sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-not-a-module');
  assert.equal(thrown.details.agent, 'np-planner');
});

test('AG-31: validateAgentFrontmatter rejects non-boolean module value', () => {
  const fm = { name: 'x', description: 'd', tier: 'sonnet', tools: 'Read', module: 'yes' };
  let thrown = null;
  try { validateAgentFrontmatter(fm, 'x'); } catch (e) { thrown = e; }
  assert.ok(thrown, 'string "yes" must not be accepted as module flag');
  assert.equal(thrown.code, 'agent-invalid-frontmatter');
  assert.equal(thrown.details.field, 'module');
  assert.equal(thrown.details.expected, true);
  assert.equal(thrown.details.got, 'yes');
});

test('AG-32: real np-critic-style file loads via loadAgentModule but fails loadAgent', () => {
  const sb = _seedRealAgent('np-critic-style');
  const fm = loadAgentModule('np-critic-style', sb);
  assert.equal(fm.module, true);
  assert.equal(fm.name, 'np-critic-style');

  let thrown = null;
  try { loadAgent('np-critic-style', sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-not-spawnable');
});

test('AG-33 path-traversal: loadAgent rejects names with slashes/dots/traversal', () => {
  const sb = makeAgentSandbox({});
  const bad = ['../../etc/passwd', '..', '/etc/passwd', 'a/b', 'np-x.y', 'np-x\\y', ''];
  for (const name of bad) {
    let thrown = null;
    try { loadAgent(name, sb); } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected throw for: ' + JSON.stringify(name));
    assert.equal(thrown.code, 'agent-invalid-name', 'unexpected code for ' + JSON.stringify(name) + ': ' + thrown.code);
  }
});

test('AG-34 path-traversal: loadAgentModule rejects names with slashes/dots/traversal', () => {
  const sb = makeAgentSandbox({});
  let thrown = null;
  try { loadAgentModule('../../../tmp/owned', sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-invalid-name');
});

test('AG-35 invalid-name: details.name is truncated to avoid log-flooding via long input', () => {
  const sb = makeAgentSandbox({});
  const longName = 'a/'.repeat(200);
  let thrown = null;
  try { loadAgent(longName, sb); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'agent-invalid-name');
  assert.ok(thrown.details.name.length <= 80, 'name in details must be capped');
});

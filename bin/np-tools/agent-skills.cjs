const { getAgentSkills } = require('../../lib/agents.cjs');

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const cwd = context.cwd || process.cwd();
  const name = Array.isArray(args) ? args[0] : undefined;
  if (!name) { stdout.write('{}\n'); return; }
  let skills = [];
  try { skills = getAgentSkills(name, cwd); } catch { skills = []; }
  stdout.write(JSON.stringify(skills) + '\n');
}

module.exports = { run };

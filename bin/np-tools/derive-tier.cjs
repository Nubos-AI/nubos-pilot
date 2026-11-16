'use strict';

const fs = require('node:fs');

const { classifyTier } = require('../../lib/tier-classify.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const { emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs derive-tier --files <a,b,c> [--name <text>] [--desc <text>]',
    '  np-tools.cjs derive-tier --plan <path-to-PLAN.md>',
    '',
    'Advisory: derives a suggested executor tier (haiku|sonnet|opus) from the',
    'task\'s observable signals. The planner remains the decider.',
  ].join('\n');
}

function _fromPlan(planPath) {
  const raw = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const nameMatch = String(body || '').match(/^#\s+(?:.*?—\s*)?(.+?)\s*$/m);
  return {
    files_modified: Array.isArray(frontmatter.files_modified) ? frontmatter.files_modified : [],
    name: nameMatch ? nameMatch[1] : (frontmatter.id || ''),
    desc: String(body || ''),
  };
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  let files = null;
  let name = '';
  let desc = '';
  let planPath = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') { stdout.write(_usage() + '\n'); return 0; }
    else if (a === '--files') { files = args[++i] || ''; }
    else if (a.startsWith('--files=')) { files = a.slice('--files='.length); }
    else if (a === '--name') { name = args[++i] || ''; }
    else if (a.startsWith('--name=')) { name = a.slice('--name='.length); }
    else if (a === '--desc') { desc = args[++i] || ''; }
    else if (a.startsWith('--desc=')) { desc = a.slice('--desc='.length); }
    else if (a === '--plan') { planPath = args[++i] || ''; }
    else if (a.startsWith('--plan=')) { planPath = a.slice('--plan='.length); }
    else {
      stderr.write(JSON.stringify({
        code: 'derive-tier-unknown-arg',
        message: 'Unknown argument: ' + a,
        details: { arg: a },
      }) + '\n');
      return 1;
    }
  }

  try {
    let task;
    if (planPath) {
      task = _fromPlan(planPath);
    } else {
      const list = files == null
        ? []
        : String(files).split(',').map((s) => s.trim()).filter(Boolean);
      task = { files_modified: list, name, desc };
    }
    const result = classifyTier(task);
    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'derive-tier-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

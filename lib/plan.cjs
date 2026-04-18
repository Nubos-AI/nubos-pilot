const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { NubosPilotError } = require('./core.cjs');

const PLAN_FILENAME_RE = /^\d{2}(\.\d+)?-\d{2}-PLAN\.md$/;

function parsePlan(planPath) {
  let raw;
  try {
    raw = fs.readFileSync(planPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new NubosPilotError(
        'plan-not-found',
        `PLAN.md not found at ${planPath}`,
        { path: planPath, cause: err.code },
      );
    }
    throw err;
  }
  const { frontmatter, body } = extractFrontmatter(raw);
  return { frontmatter, body, path: planPath };
}

function listPlans(phaseDir) {
  let entries;
  try {
    entries = fs.readdirSync(phaseDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const matches = entries.filter((name) => name === 'PLAN.md' || PLAN_FILENAME_RE.test(name));
  matches.sort();
  return matches.map((name) => path.join(phaseDir, name));
}

function enumerateTasks(planPath) {
  const tasksDir = path.join(path.dirname(planPath), 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(tasksDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const md = entries.filter((name) => name.endsWith('.md'));
  md.sort();
  return md.map((name) => path.join(tasksDir, name));
}

const { computeWaves } = require('./tasks.cjs');

function shouldPromoteToTasks(plan) {
  const tasks = (plan && plan.tasks) || [];
  const triggers = [];
  if (tasks.length === 0) return { promote: false, triggers };

  const computeInput = tasks.map((t) => ({
    id: t.id,
    depends_on: (t.frontmatter && t.frontmatter.depends_on) || [],
    wave: t.frontmatter && t.frontmatter.wave,
  }));
  const { waves } = computeWaves(computeInput);
  if (waves.length > 1) {
    const maxWaveSize = Math.max(...waves.map((w) => w.length));
    if (maxWaveSize >= 2) triggers.push('parallelism');
  }

  const tierSet = new Set(tasks.map((t) => t.frontmatter && t.frontmatter.tier));
  if (tierSet.size >= 2) triggers.push('mixed-tiers');

  if (
    tasks.some(
      (t) => ((t.frontmatter && t.frontmatter.depends_on) || []).length >= 2,
    )
  ) {
    triggers.push('non-linear-deps');
  }

  return { promote: triggers.length > 0, triggers };
}

module.exports = { parsePlan, listPlans, enumerateTasks, shouldPromoteToTasks };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');

const { initWorkflows, topLevelCommands } = require(path.join(REPO_ROOT, 'np-tools.cjs'));

const BUILTIN_TOPLEVEL = new Set([
  'init', 'next', 'progress', 'state', 'help', 'askuser',
]);

const KNOWN_COMMANDS = new Set([
  ...Object.keys(initWorkflows),
  ...Object.keys(topLevelCommands),
  ...BUILTIN_TOPLEVEL,
]);

const LEGACY_MISSING_FRONTMATTER = new Set([
  'discuss-phase-power.md', 'dispatch.md', 'doctor.md', 'help.md',
  'next.md', 'progress.md', 'queue.md', 'state.md', 'triage.md',
]);

const LEGACY_COMMAND_FILENAME_OVERRIDES = new Set([
  'discuss-phase-assumptions.md',
]);

const LEGACY_UNKNOWN_COMMAND_REFERENCES = new Set([
  'review', 'secure-phase', 'frontmatter-set', 'validate-phase',
]);

const NEW_WORKFLOWS = [
  'scan-codebase.md', 'update-docs.md', 'discuss-project.md', 'new-project.md',
];

function listWorkflowFiles() {
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function extractNpToolsCommands(body) {
  const commands = new Set();
  const direct = /node\s+np-tools\.cjs\s+([a-z][a-z0-9-]*)/g;
  const init = /node\s+np-tools\.cjs\s+init\s+([a-z][a-z0-9-]*)/g;
  let m;
  while ((m = direct.exec(body)) !== null) {
    if (m[1] !== 'init') commands.add(m[1]);
  }
  while ((m = init.exec(body)) !== null) {
    commands.add(m[1]);
  }
  return commands;
}

test('WFL-1: every non-legacy workflow has frontmatter with command + description', () => {
  const files = listWorkflowFiles();
  assert.ok(files.length >= 20, `expected many workflows, found ${files.length}`);
  const issues = [];
  for (const file of files) {
    const base = path.basename(file);
    if (LEGACY_MISSING_FRONTMATTER.has(base)) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(raw);
    const rel = path.relative(REPO_ROOT, file);
    if (!fm) {
      issues.push(rel + ': missing frontmatter');
      continue;
    }
    if (!fm.command) issues.push(rel + ': missing command:');
    if (!fm.description) issues.push(rel + ': missing description:');
  }
  assert.deepEqual(issues, [], 'workflow frontmatter issues: ' + JSON.stringify(issues, null, 2));
});

test('WFL-2: command name matches filename for non-override workflows', () => {
  const files = listWorkflowFiles();
  const issues = [];
  for (const file of files) {
    const base = path.basename(file);
    if (LEGACY_MISSING_FRONTMATTER.has(base)) continue;
    if (LEGACY_COMMAND_FILENAME_OVERRIDES.has(base)) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(raw);
    if (!fm || !fm.command) continue;
    const rel = path.relative(REPO_ROOT, file);
    const slug = path.basename(file, '.md');
    const expected = 'np:' + slug;
    if (fm.command !== expected) {
      issues.push(`${rel}: command="${fm.command}" expected="${expected}"`);
    }
  }
  assert.deepEqual(issues, [], 'workflow command/filename mismatches: ' + JSON.stringify(issues, null, 2));
});

test('WFL-3: every referenced np-tools command is registered (legacy known-missing excluded)', () => {
  const files = listWorkflowFiles();
  const unknown = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const referenced = extractNpToolsCommands(raw);
    for (const cmd of referenced) {
      if (KNOWN_COMMANDS.has(cmd)) continue;
      if (LEGACY_UNKNOWN_COMMAND_REFERENCES.has(cmd)) continue;
      unknown.push(path.relative(REPO_ROOT, file) + ' → ' + cmd);
    }
  }
  assert.deepEqual(unknown, [], 'unknown np-tools commands referenced: ' + JSON.stringify(unknown, null, 2));
});

test('WFL-4: new codebase workflows exist with well-formed frontmatter', () => {
  for (const name of NEW_WORKFLOWS) {
    const file = path.join(WORKFLOWS_DIR, name);
    assert.ok(fs.existsSync(file), `missing workflow: ${name}`);
    const raw = fs.readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(raw);
    assert.ok(fm, `${name} has no frontmatter`);
    const slug = path.basename(name, '.md');
    assert.equal(fm.command, 'np:' + slug);
    assert.ok(fm.description && fm.description.length > 20);
  }
});

test('WFL-5: new codebase subcommands are registered in np-tools.cjs', () => {
  assert.ok(topLevelCommands['scan-codebase'], 'scan-codebase not registered');
  assert.ok(topLevelCommands['update-docs'], 'update-docs not registered');
  assert.ok(initWorkflows['discuss-project'], 'discuss-project not in initWorkflows');
});

test('WFL-6: new-project workflow references discuss-project and scan-codebase', () => {
  const file = path.join(WORKFLOWS_DIR, 'new-project.md');
  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(raw.includes('discuss-project'), 'new-project should chain into discuss-project');
  assert.ok(raw.includes('scan-codebase'), 'new-project should mention scan-codebase');
});

test('WFL-7: legacy allow-lists only cover files that still exist', () => {
  for (const base of LEGACY_MISSING_FRONTMATTER) {
    assert.ok(
      fs.existsSync(path.join(WORKFLOWS_DIR, base)),
      `LEGACY_MISSING_FRONTMATTER contains stale entry: ${base}`,
    );
  }
  for (const base of LEGACY_COMMAND_FILENAME_OVERRIDES) {
    assert.ok(
      fs.existsSync(path.join(WORKFLOWS_DIR, base)),
      `LEGACY_COMMAND_FILENAME_OVERRIDES contains stale entry: ${base}`,
    );
  }
});

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');
const COMPLETENESS_PATH = path.join(REPO_ROOT, 'templates', 'COMPLETENESS.md');

const AGENT_HEADING_RE = /^##\s+Completeness Mandate\b/m;
const WORKFLOW_HEADING_RE = /^##\s+Definition of Done\b/m;
const COMPLETENESS_LINK_RE = /COMPLETENESS\.md/;

function _listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f))
    .sort();
}

function checkAgents(rootDir) {
  const dir = rootDir ? path.join(rootDir, 'agents') : AGENTS_DIR;
  const out = [];
  for (const file of _listMd(dir)) {
    const body = fs.readFileSync(file, 'utf-8');
    if (!AGENT_HEADING_RE.test(body)) {
      out.push({ file, kind: 'agent', code: 'missing-completeness-mandate', message: 'Agent file lacks "## Completeness Mandate" heading.' });
      continue;
    }
    if (!COMPLETENESS_LINK_RE.test(body)) {
      out.push({ file, kind: 'agent', code: 'missing-completeness-link', message: 'Agent file mentions Mandate but does not link to templates/COMPLETENESS.md.' });
    }
  }
  return out;
}

function checkWorkflows(rootDir) {
  const dir = rootDir ? path.join(rootDir, 'workflows') : WORKFLOWS_DIR;
  const out = [];
  for (const file of _listMd(dir)) {
    const body = fs.readFileSync(file, 'utf-8');
    if (!WORKFLOW_HEADING_RE.test(body)) {
      out.push({ file, kind: 'workflow', code: 'missing-definition-of-done', message: 'Workflow file lacks "## Definition of Done" heading.' });
      continue;
    }
    if (!COMPLETENESS_LINK_RE.test(body)) {
      out.push({ file, kind: 'workflow', code: 'missing-completeness-link', message: 'Workflow file mentions Definition of Done but does not link to templates/COMPLETENESS.md.' });
    }
  }
  return out;
}

function checkCompletenessFile(rootDir) {
  const file = rootDir ? path.join(rootDir, 'templates', 'COMPLETENESS.md') : COMPLETENESS_PATH;
  const out = [];
  if (!fs.existsSync(file)) {
    out.push({ file, kind: 'doctrine', code: 'missing-completeness-file', message: 'templates/COMPLETENESS.md is missing.' });
    return out;
  }
  const body = fs.readFileSync(file, 'utf-8');
  // R5/nit from fifth review: capture IDs in one matchAll pass instead of
  // matching twice (once with /g to find headings, once per heading to pull
  // out the digit). The /g + matchAll pattern surfaces the capture group
  // directly.
  const ids = [];
  for (const m of body.matchAll(/^###\s+(\d+)\.\s+/gm)) {
    ids.push(Number(m[1]));
  }
  const expected = Array.from({ length: 12 }, (_, i) => i + 1);
  if (ids.length !== 12 || ids.some((id, i) => id !== expected[i])) {
    out.push({ file, kind: 'doctrine', code: 'doctrine-drift', message: 'templates/COMPLETENESS.md must contain exactly 12 sequentially numbered rule headings ("### 1." through "### 12.").', ids });
  }
  return out;
}

function checkAll(rootDir) {
  const root = rootDir || REPO_ROOT;
  const violations = [
    ...checkCompletenessFile(root),
    ...checkAgents(root),
    ...checkWorkflows(root),
  ];
  return { violations, exitCode: violations.length ? 1 : 0 };
}

function main() {
  const { violations, exitCode } = checkAll(process.argv[2] || REPO_ROOT);
  if (violations.length) {
    process.stderr.write('check-completeness: ' + violations.length + ' violation(s)\n');
    for (const v of violations) {
      process.stderr.write('  ' + v.file + '  [' + v.kind + ':' + v.code + ']  ' + v.message + '\n');
    }
  }
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = {
  checkAgents,
  checkWorkflows,
  checkCompletenessFile,
  checkAll,
  REPO_ROOT,
  AGENT_HEADING_RE,
  WORKFLOW_HEADING_RE,
  COMPLETENESS_LINK_RE,
};

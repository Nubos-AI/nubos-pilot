#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SKILL_ACK_AGENTS } = require('../lib/nubosloop-audit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');
const COMPLETENESS_PATH = path.join(REPO_ROOT, 'templates', 'COMPLETENESS.md');

const AGENT_HEADING_RE = /^##\s+Completeness Mandate\b/m;
const WORKFLOW_HEADING_RE = /^##\s+Definition of Done\b/m;
const COMPLETENESS_LINK_RE = /COMPLETENESS\.md/;
const UNLAZY_HEADING_RE = /^##\s+Unlazy Discipline\b/m;
const UNLAZY_LINK_RE = /np-unlazy\/SKILL\.md/;
const UNLAZY_SKILL_NAME_RE = /^name:\s*np-unlazy\s*$/m;
const SKILL_ACK_RE = /skill-audit ack[^`\n]*/g;

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

function _checkUnlazyBlock(dir, kind) {
  const out = [];
  for (const file of _listMd(dir)) {
    const body = fs.readFileSync(file, 'utf-8');
    if (!UNLAZY_HEADING_RE.test(body)) {
      out.push({ file, kind, code: 'missing-unlazy-discipline', message: 'File lacks "## Unlazy Discipline" heading.' });
      continue;
    }
    if (!UNLAZY_LINK_RE.test(body)) {
      out.push({ file, kind, code: 'missing-unlazy-link', message: 'File mentions Unlazy Discipline but does not reference np-unlazy/SKILL.md.' });
    }
  }
  return out;
}

function checkAgentsUnlazy(rootDir) {
  return _checkUnlazyBlock(rootDir ? path.join(rootDir, 'agents') : AGENTS_DIR, 'agent');
}

function checkWorkflowsUnlazy(rootDir) {
  return _checkUnlazyBlock(rootDir ? path.join(rootDir, 'workflows') : WORKFLOWS_DIR, 'workflow');
}

function checkAgentsSkillAck(rootDir) {
  const out = [];
  for (const file of _listMd(rootDir ? path.join(rootDir, 'agents') : AGENTS_DIR)) {
    const name = path.basename(file, '.md');
    const stamps = fs.readFileSync(file, 'utf-8').match(SKILL_ACK_RE) || [];
    if (!SKILL_ACK_AGENTS.includes(name)) {
      if (stamps.length) {
        out.push({ file, kind: 'agent', code: 'unlazy-ack-not-eligible', message: 'Only np-executor and np-build-fixer may run skill-audit ack.' });
      }
      continue;
    }
    if (!stamps.length || stamps.some((s) => !s.includes('--agent ' + name))) {
      out.push({ file, kind: 'agent', code: 'unlazy-ack-missing-agent', message: 'Every skill-audit ack must pass --agent ' + name + '.' });
    }
  }
  return out;
}

function checkUnlazySkill(rootDir) {
  const root = rootDir || REPO_ROOT;
  const file = path.join(root, 'skills', 'np-unlazy', 'SKILL.md');
  if (!fs.existsSync(file)) {
    return [{ file, kind: 'skill', code: 'missing-unlazy-skill', message: 'skills/np-unlazy/SKILL.md is missing.' }];
  }
  const body = fs.readFileSync(file, 'utf-8');
  const out = [];
  if (!UNLAZY_SKILL_NAME_RE.test(body)) {
    out.push({ file, kind: 'skill', code: 'unlazy-skill-name', message: 'skills/np-unlazy/SKILL.md frontmatter must declare "name: np-unlazy".' });
  }
  const missingRoles = _listMd(path.join(root, 'agents'))
    .map((f) => path.basename(f, '.md'))
    .filter((name) => !body.includes('`' + name + '`'));
  if (missingRoles.length) {
    out.push({ file, kind: 'skill', code: 'unlazy-role-drift', message: 'np-unlazy "Role obligations" table lacks a row for: ' + missingRoles.join(', ') + '.', missingRoles });
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
    ...checkUnlazySkill(root),
    ...checkAgentsUnlazy(root),
    ...checkAgentsSkillAck(root),
    ...checkWorkflowsUnlazy(root),
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
  checkUnlazySkill,
  checkAgentsUnlazy,
  checkAgentsSkillAck,
  checkWorkflowsUnlazy,
  checkAll,
  REPO_ROOT,
  AGENT_HEADING_RE,
  WORKFLOW_HEADING_RE,
  COMPLETENESS_LINK_RE,
  UNLAZY_HEADING_RE,
  UNLAZY_LINK_RE,
};

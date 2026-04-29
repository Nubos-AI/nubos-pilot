#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_ROOT = path.resolve(SOURCE_ROOT, '..', '..', 'knowledge', 'libraries', 'nubos-pilot', 'v1');

const { extractFrontmatter } = require(path.join(SOURCE_ROOT, 'lib', 'frontmatter.cjs'));
const { COMMANDS } = require(path.join(SOURCE_ROOT, 'bin', 'np-tools', '_commands.cjs'));
const { RUNTIMES } = require(path.join(SOURCE_ROOT, 'lib', 'install', 'runtimes-registry.cjs'));

const FIRST_CLASS_RUNTIMES = new Set(['claude', 'codex', 'gemini', 'opencode']);

function loadAgents() {
  const dir = path.join(SOURCE_ROOT, 'agents');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { frontmatter } = extractFrontmatter(raw);
      return {
        name: frontmatter.name || file.replace(/\.md$/, ''),
        tier: frontmatter.tier || '',
        tools: frontmatter.tools || '',
        description: (frontmatter.description || '').replace(/\|/g, '\\|'),
      };
    });
}

function tierOrder(tier) {
  return { opus: 0, sonnet: 1, haiku: 2 }[tier] ?? 3;
}

function renderAgentCatalog(agents) {
  const lines = ['| Agent | Tier | Tools | Description |', '|---|---|---|---|'];
  const sorted = agents.slice().sort((a, b) => {
    const t = tierOrder(a.tier) - tierOrder(b.tier);
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
  for (const a of sorted) {
    lines.push(`| \`${a.name}\` | \`${a.tier}\` | ${a.tools} | ${a.description} |`);
  }
  return lines.join('\n');
}

function renderAgentTierTable(agents) {
  const lines = ['| Agent | Tier |', '|---|---|'];
  const sorted = agents.slice().sort((a, b) => {
    const t = tierOrder(a.tier) - tierOrder(b.tier);
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
  for (const a of sorted) {
    lines.push(`| \`${a.name}\` | \`${a.tier}\` |`);
  }
  return lines.join('\n');
}

function renderRuntimes(runtimes) {
  const firstClass = runtimes.filter((r) => FIRST_CLASS_RUNTIMES.has(r.id));
  const additional = runtimes.filter((r) => !FIRST_CLASS_RUNTIMES.has(r.id));
  const out = [];
  out.push('**First-class runtimes** (full adapter + managed-markdown):');
  out.push('');
  out.push('| Runtime | id | Local install path | Managed Markdown |');
  out.push('|---|---|---|---|');
  for (const r of firstClass) {
    out.push(`| ${r.label} | \`${r.id}\` | \`${r.localDir}/${r.payloadSubdir}\` | \`${r.agentsMd}\` |`);
  }
  out.push('');
  out.push('**Additional runtimes** (selectable via `--agent <id>`):');
  out.push('');
  out.push('| Runtime | id | Local install path | Managed Markdown |');
  out.push('|---|---|---|---|');
  for (const r of additional) {
    out.push(`| ${r.label} | \`${r.id}\` | \`${r.localDir}/${r.payloadSubdir}\` | \`${r.agentsMd}\` |`);
  }
  out.push('');
  out.push(`**Total:** ${runtimes.length} ids in \`KNOWN_RUNTIMES\`.`);
  return out.join('\n');
}

function renderCliCommands(commands) {
  const groups = new Map();
  for (const c of commands) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  const order = ['Planning', 'Execution', 'Review', 'Capture', 'Install', 'Utility'];
  const out = [];
  for (const cat of order) {
    const list = groups.get(cat);
    if (!list || !list.length) continue;
    out.push(`### ${cat}`);
    out.push('');
    out.push('| Command | Description |');
    out.push('|---|---|');
    for (const c of list.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = (c.description || '').replace(/\|/g, '\\|');
      out.push(`| \`${c.name}\` | ${desc} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

const SECTIONS = [
  {
    id: 'agent-catalog',
    file: path.join(KNOWLEDGE_ROOT, 'agents', 'catalog.md'),
    render: (data) => renderAgentCatalog(data.agents),
  },
  {
    id: 'agent-tier-table',
    file: path.join(KNOWLEDGE_ROOT, 'reference', 'agent-frontmatter-schema.md'),
    render: (data) => renderAgentTierTable(data.agents),
  },
  {
    id: 'runtimes',
    file: path.join(KNOWLEDGE_ROOT, 'concepts', 'runtimes.md'),
    render: (data) => renderRuntimes(data.runtimes),
  },
  {
    id: 'cli-commands',
    file: path.join(KNOWLEDGE_ROOT, 'reference', 'cli-commands.md'),
    render: (data) => renderCliCommands(data.commands),
  },
];

function spliceSection(content, id, body) {
  const start = `<!-- @generated:${id} -->`;
  const end = `<!-- @end:${id} -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { ok: false, reason: `markers @generated:${id} … @end:${id} not found` };
  }
  const before = content.slice(0, startIdx + start.length);
  const after = content.slice(endIdx);
  const next = `${before}\n${body}\n${after}`;
  return { ok: true, content: next };
}

function readSectionBody(content, id) {
  const start = `<!-- @generated:${id} -->`;
  const end = `<!-- @end:${id} -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return null;
  return content.slice(startIdx + start.length, endIdx).replace(/^\n|\n$/g, '');
}

function run({ mode }) {
  const data = {
    agents: loadAgents(),
    runtimes: RUNTIMES,
    commands: COMMANDS,
  };
  const reports = [];
  for (const section of SECTIONS) {
    if (!fs.existsSync(section.file)) {
      reports.push({ section: section.id, status: 'missing-file', detail: section.file });
      continue;
    }
    const original = fs.readFileSync(section.file, 'utf-8');
    const body = section.render(data);
    if (mode === 'check') {
      const current = readSectionBody(original, section.id);
      if (current === null) {
        reports.push({ section: section.id, status: 'no-markers', detail: section.file });
        continue;
      }
      if (current !== body) {
        reports.push({ section: section.id, status: 'drift', detail: section.file });
      } else {
        reports.push({ section: section.id, status: 'ok' });
      }
      continue;
    }
    const spliced = spliceSection(original, section.id, body);
    if (!spliced.ok) {
      reports.push({ section: section.id, status: 'splice-failed', detail: spliced.reason });
      continue;
    }
    if (spliced.content === original) {
      reports.push({ section: section.id, status: 'unchanged' });
    } else {
      fs.writeFileSync(section.file, spliced.content);
      reports.push({ section: section.id, status: 'wrote' });
    }
  }
  return reports;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--check') ? 'check' : 'write';
  const reports = run({ mode });
  let exit = 0;
  for (const r of reports) {
    const tag = (r.status === 'ok' || r.status === 'unchanged' || r.status === 'wrote')
      ? 'ok'
      : 'FAIL';
    if (tag === 'FAIL') exit = 1;
    process.stdout.write(`[${tag}] ${r.section.padEnd(20)} ${r.status}${r.detail ? '  ' + r.detail : ''}\n`);
  }
  if (mode === 'check' && exit !== 0) {
    process.stderr.write('\nDocs are out of sync. Run: npm run docs:generate\n');
  }
  process.exit(exit);
}

if (require.main === module) main();

module.exports = { run, loadAgents, renderAgentCatalog, renderRuntimes, renderCliCommands };

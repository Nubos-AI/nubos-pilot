#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const PHASE_HEADER_RE = /^### Phase (\d+(?:\.\d+)?): (.+?)$/gm;
const GOAL_RE = /^\*\*Goal\*\*:\s*(.+)$/m;
const DEPENDS_RE = /^\*\*Depends on\*\*:\s*(.+)$/m;
const REQS_RE = /^\*\*Requirements\*\*:\s*(.+)$/m;
const SC_BLOCK_RE = /\*\*Success Criteria\*\*[^\n]*:\s*\n([\s\S]*?)(?=\n\*\*|\n### |\n## |$)/;
const SC_BULLET_RE = /^\s+\d+\.\s+(.+)$/gm;
const PLANS_LINE_RE = /^\*\*Plans\*\*:\s*(.+)$/m;
const PLAN_BULLET_RE = /^\s*-\s*\[([x ])\]\s*(\S+\.md|\S+)\s*(?:—|--)\s*(.+)$/gm;
const PLAN_INLINE_RE = /(\d{2}-\d{2}(?:-PLAN\.md)?)\s*\(([^)]+)\)/g;
const TABLE_ROW_RE = /^\|\s*(\d+(?:\.\d+)?)\.\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm;

function _splitSections(raw) {
  const sections = [];
  const matches = [];
  for (const m of raw.matchAll(PHASE_HEADER_RE)) {
    matches.push({ index: m.index, number: m[1], name: m[2].trim() });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    sections.push({ number: matches[i].number, name: matches[i].name, body: raw.slice(start, end) });
  }
  return sections;
}

function _parsePlans(body) {
  const plansLine = body.match(PLANS_LINE_RE);
  const out = [];
  if (!plansLine) return out;
  const after = plansLine[1].trim();
  for (const im of after.matchAll(PLAN_INLINE_RE)) {
    const id = im[1].replace(/-PLAN\.md$/, '');
    const state = im[2].trim().toLowerCase();
    out.push({ id, title: '', complete: state === 'complete' || state === 'done' });
  }
  for (const bm of body.matchAll(PLAN_BULLET_RE)) {
    const id = bm[2].trim().replace(/-PLAN\.md$/, '');
    out.push({ id, title: bm[3].trim(), complete: bm[1] === 'x' });
  }
  return out;
}

function _parseProgressTable(raw) {
  const table = new Map();
  for (const m of raw.matchAll(TABLE_ROW_RE)) {
    const num = m[1];
    const name = m[2].trim();
    const status = m[4].trim();
    if (status === 'Phase' || status === 'Status') continue;
    table.set(num, { name, complete: /^complete$/i.test(status) });
  }
  return table;
}

function _statusFromRow(row) {
  if (!row) return 'pending';
  if (row.complete) return 'done';
  return 'pending';
}

function parseMd(raw) {
  const sections = _splitSections(raw);
  const table = _parseProgressTable(raw);

  const phases = sections.map((s) => {
    const goal = (s.body.match(GOAL_RE) || [])[1];
    const depends = (s.body.match(DEPENDS_RE) || [])[1];
    const reqsRaw = (s.body.match(REQS_RE) || [])[1];
    const requirements = reqsRaw
      ? reqsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const success_criteria = [];
    const scBlock = s.body.match(SC_BLOCK_RE);
    if (scBlock) {
      for (const bm of scBlock[1].matchAll(SC_BULLET_RE)) {
        success_criteria.push(bm[1].trim());
      }
    }
    const plans = _parsePlans(s.body);
    const row = table.get(s.number);

    const numberValue = /^\d+$/.test(s.number) ? Number(s.number) : s.number;
    return {
      number: numberValue,
      name: s.name,
      slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      goal: goal ? goal.trim() : '',
      depends_on: depends ? depends.trim() : null,
      requirements,
      success_criteria,
      plans,
      status: _statusFromRow(row),
    };
  });

  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'milestone',
        phases,
      },
    ],
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  try {
    const root = process.cwd();
    const mdPath = path.join(root, '.planning', 'ROADMAP.md');
    const ymlPath = path.join(root, '.nubos-pilot', 'roadmap.yaml');

    const raw = fs.readFileSync(mdPath, 'utf-8');
    const data = parseMd(raw);

    if (fs.existsSync(ymlPath)) {
      try {
        const existing = YAML.parse(fs.readFileSync(ymlPath, 'utf-8'));
        if (deepEqual(existing, data)) {
          fs.writeSync(2, `migrate-roadmap-to-yaml: ${ymlPath} already up-to-date\n`);
          return;
        }
      } catch {

      }
    }

    fs.mkdirSync(path.dirname(ymlPath), { recursive: true });
    fs.writeFileSync(ymlPath, YAML.stringify(data, { indent: 2 }));
    process.stdout.write(`Wrote ${ymlPath}\n`);
  } catch (err) {
    const code = (err && err.code) || 'migrate-error';
    const message = (err && err.message) || String(err);
    fs.writeSync(2, JSON.stringify({ error: { code, message } }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseMd };

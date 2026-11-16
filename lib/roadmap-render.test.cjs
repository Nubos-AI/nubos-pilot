const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const render = require('./roadmap-render.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'roadmap');
const MINIMAL = fs.readFileSync(path.join(FIXTURES, 'roadmap-minimal.yaml'), 'utf-8');

const sandboxes = [];

function makeSandbox(yamlContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rr-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  if (yamlContent != null) {
    fs.writeFileSync(path.join(dir, '.nubos-pilot', 'roadmap.yaml'), yamlContent);
  }
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('RR-1: renderRoadmap writes ROADMAP.md containing generated-header marker', () => {
  const root = makeSandbox(MINIMAL);
  render.renderRoadmap(root);
  const out = fs.readFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');
  assert.ok(out.startsWith(render.GENERATED_HEADER), 'output starts with generated-header marker');
  assert.match(out, /# Roadmap/);
});

test('RR-2: renderRoadmap is byte-idempotent across two consecutive calls', () => {
  const root = makeSandbox(MINIMAL);
  render.renderRoadmap(root);
  const first = fs.readFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'));
  render.renderRoadmap(root);
  const second = fs.readFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'));
  assert.ok(Buffer.compare(first, second) === 0, 'byte-identical output');
});

test('RR-3: renderRoadmap on missing roadmap.yaml throws roadmap-render-read-error', () => {
  const root = makeSandbox(null);
  assert.throws(
    () => render.renderRoadmap(root),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'roadmap-render-read-error',
  );
});

test('RR-4: rendered MD contains all three phase names from minimal fixture', () => {
  const root = makeSandbox(MINIMAL);
  render.renderRoadmap(root);
  const out = fs.readFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');
  assert.match(out, /Foundation/);
  assert.match(out, /Hotfix/);
  assert.match(out, /Core/);
});

test('RR-5: rendered MD progress table marks Phase 1 Complete', () => {
  const root = makeSandbox(MINIMAL);
  render.renderRoadmap(root);
  const out = fs.readFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');

  assert.match(out, /\|\s*1\.\s*Foundation\s*\|[^|]*\|\s*Complete\s*\|/);
});

test('ROAD-RENDER-BACKLOG: synthetic id:backlog renders as ## Backlog, excluded from progress table', () => {
  const doc = {
    milestones: [
      {
        id: 'v1.0',
        name: 'v1',
        phases: [
          { number: 1, name: 'First', slug: 'first', goal: 'g', status: 'done', plans: [] },
        ],
      },
      {
        id: 'backlog',
        name: 'Backlog',
        phases: [
          { number: '999.1', name: 'Fix deploy key auth', slug: 'fix-deploy-key-auth', status: 'backlog', plans: [] },
          { number: '999.2', name: 'Add feature X', slug: 'add-feature-x', status: 'backlog', plans: [] },
        ],
      },
    ],
  };
  const md = render.renderMarkdown(doc);
  assert.match(md, /## Backlog/);
  assert.match(md, /Phase 999\.1: Fix deploy key auth/);
  assert.match(md, /Phase 999\.2: Add feature X/);
  const progressLines = md.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|-------'));
  const progressText = progressLines.join('\n');
  assert.doesNotMatch(progressText, /999\.1/);
  assert.match(md, /Milestones:\s*1\./);
});

test('ROAD-RENDER-COLLAPSED: collapsed:true wraps phase-details block in <details>', () => {
  const doc = {
    milestones: [
      {
        id: 'v1.0',
        name: 'v1',
        collapsed: true,
        collapsed_at: '2026-04-17',
        phases: [
          { number: 1, name: 'First', slug: 'first', goal: 'g', status: 'done', plans: [] },
        ],
      },
    ],
  };
  const md = render.renderMarkdown(doc);
  assert.match(md, /<details><summary>v1\.0 — completed on 2026-04-17<\/summary>/);
  assert.match(md, /<\/details>/);
  assert.match(md, /### Phase 1:/);
});

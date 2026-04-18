const tpl = require('./template.cjs');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const _sandboxes = [];

function makeSandbox(templates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nubos-pilot-tpl-'));
  if (templates) {
    const dir = path.join(root, '.nubos-pilot', 'templates');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(templates)) {
      fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf-8');
    }
  } else {
    fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  }
  _sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    const root = _sandboxes.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

const PHASE_CONTEXT = fs.readFileSync(path.join(__dirname, 'fixtures/templates/phase-context.md'), 'utf-8');
const PLAN_SKELETON = fs.readFileSync(path.join(__dirname, 'fixtures/templates/plan-skeleton.md'), 'utf-8');

test('TPL-1: phase-context with full vars substitutes all placeholders', () => {
  const cwd = makeSandbox({ 'phase-context': PHASE_CONTEXT });
  const out = tpl.loadTemplate('phase-context', {
    phase_number: '03',
    phase_name: 'Core Lib',
    goal: 'Build parsers',
    requirements: 'LIB-03',
  }, cwd);
  assert.match(out, /Phase 03: Core Lib/);
  assert.match(out, /Requirements: LIB-03/);
  assert.ok(!out.includes('{{'), 'no unresolved placeholders');
});

test('TPL-2: repeated {{phase_number}} substitutes in BOTH positions', () => {
  const cwd = makeSandbox({ 'phase-context': PHASE_CONTEXT });
  const out = tpl.loadTemplate('phase-context', {
    phase_number: '03',
    phase_name: 'X',
    goal: 'Y',
    requirements: 'Z',
  }, cwd);

  const occurrences = (out.match(/03/g) || []).length;
  assert.ok(occurrences >= 2, `expected ≥2 occurrences of "03", got ${occurrences}`);
});

test('TPL-3: numeric value (3) stringifies to "3"', () => {
  const cwd = makeSandbox({ tiny: 'value={{n}}' });
  const out = tpl.loadTemplate('tiny', { n: 3 }, cwd);
  assert.equal(out, 'value=3');
});

test('TPL-4: boolean true stringifies to "true"', () => {
  const cwd = makeSandbox({ tiny: 'flag={{b}}' });
  const out = tpl.loadTemplate('tiny', { b: true }, cwd);
  assert.equal(out, 'flag=true');
});

test('TPL-5: empty-string value substitutes empty, does NOT throw', () => {
  const cwd = makeSandbox({ tiny: 'x={{e}}|y' });
  const out = tpl.loadTemplate('tiny', { e: '' }, cwd);
  assert.equal(out, 'x=|y');
});

test('TPL-6: template with no placeholders returns content unchanged', () => {
  const content = '# Static\n\nNo placeholders here.\n';
  const cwd = makeSandbox({ static: content });
  const out = tpl.loadTemplate('static', {}, cwd);
  assert.equal(out, content);
});

test('TPL-7: missing var → throws template-unresolved-var with available keys', () => {
  const cwd = makeSandbox({ 'phase-context': PHASE_CONTEXT });
  let thrown = null;
  try {
    tpl.loadTemplate('phase-context', { phase_number: '03' }, cwd);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected throw');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'template-unresolved-var');
  assert.ok(thrown.details, 'details object present');
  assert.equal(thrown.details.template, 'phase-context');
  assert.ok(['phase_name', 'goal', 'requirements'].includes(thrown.details.variable),
    `variable should be one of the missing keys, got ${thrown.details.variable}`);
  assert.deepEqual(thrown.details.available, ['phase_number']);
});

test('TPL-8: missing template file → throws template-not-found', () => {
  const cwd = makeSandbox({});
  let thrown = null;
  try {
    tpl.loadTemplate('missing-name', {}, cwd);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected throw');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'template-not-found');
  assert.equal(thrown.details.template, 'missing-name');
  assert.ok(thrown.details.path.endsWith(path.join('templates', 'missing-name.md')),
    `path should end with templates/missing-name.md, got ${thrown.details.path}`);
});

test('TPL-9: {{123}} (digit-leading, non-identifier) returns verbatim', () => {
  const cwd = makeSandbox({ edge: 'before {{123}} after' });
  const out = tpl.loadTemplate('edge', {}, cwd);
  assert.equal(out, 'before {{123}} after');
});

test('TPL-10: {{  spaced  }} (whitespace around identifier) IS a placeholder', () => {
  const cwd = makeSandbox({ edge: 'x={{  name  }}' });
  const out = tpl.loadTemplate('edge', { name: 'ok' }, cwd);
  assert.equal(out, 'x=ok');
});

test('TPL-11: listTemplates returns sorted basenames without .md', () => {
  const cwd = makeSandbox({
    'phase-context': PHASE_CONTEXT,
    'plan-skeleton': PLAN_SKELETON,
  });
  const list = tpl.listTemplates(cwd);
  assert.deepEqual(list, ['phase-context', 'plan-skeleton']);
});

test('TPL-12: listTemplates on sandbox without templates dir returns []', () => {
  const cwd = makeSandbox({});
  const list = tpl.listTemplates(cwd);
  assert.deepEqual(list, []);
});

test('TPL-13: cwd with no .nubos-pilot ancestor → projectStateDir throws not-in-project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nubos-pilot-tpl-noroot-'));
  _sandboxes.push(root);
  let thrown = null;
  try {
    tpl.listTemplates(root);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected throw');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'not-in-project');
});

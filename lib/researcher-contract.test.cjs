const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadAgent, FORBIDDEN } = require('./agents.cjs');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'np-researcher.md');
const BODY = fs.readFileSync(AGENT_PATH, 'utf-8');

function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rc-contract-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'np-researcher.md'), BODY, 'utf-8');
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('RC-1: loadAgent("np-researcher") returns tier=sonnet', () => {
  withSandbox((sb) => {
    const fm = loadAgent('np-researcher', sb);
    assert.equal(fm.tier, 'sonnet');
    assert.equal(fm.name, 'np-researcher');
  });
});

test('RC-2: tools list contains the required web+MCP surface', () => {
  withSandbox((sb) => {
    const fm = loadAgent('np-researcher', sb);
    assert.equal(typeof fm.tools, 'string');
    for (const needle of ['WebSearch', 'WebFetch', 'mcp__context7__*', 'mcp__firecrawl__*', 'mcp__exa__*']) {
      assert.ok(
        fm.tools.includes(needle),
        'tools string missing "' + needle + '" — got: ' + fm.tools,
      );
    }
  });
});

test('RC-3: body contains verbatim offline-confirm German prompt (D-21)', () => {
  const verbatim = 'Kein Web-/Context7-Zugriff verfügbar — mit lokalen Quellen (Repo + Prior-Phase-CONTEXT.md) fortfahren?';
  assert.ok(BODY.includes(verbatim), 'body missing verbatim D-21 prompt');
});

test('RC-4: body contains "## Research Coverage" literal heading (D-22)', () => {
  assert.ok(
    /^## Research Coverage$/m.test(BODY),
    'body missing "## Research Coverage" heading on its own line',
  );
});

test('RC-6: frontmatter contains no FORBIDDEN field', () => {
  withSandbox((sb) => {
    const fm = loadAgent('np-researcher', sb);
    for (const f of FORBIDDEN) {
      assert.equal(fm[f], undefined, 'FORBIDDEN field present: ' + f);
    }
  });
});

'use strict';

// Drift guard: keeps the Rule 9 documentation in sync with the SEARCH_TOOLS
// constant. The field failure these tests prevent: execute-phase.md once
// enumerated only `search-knowledge` / `match-existing-learning` and omitted
// the `knowledge-search` CLI — the only Rule 9 satisfier an audited agent can
// actually run via Bash. An orchestrator reading that stale list concluded
// Rule 9 was unsatisfiable and stalled every task.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..');
const loop = require('../lib/nubosloop.cjs');
const { COMMANDS } = require('../bin/np-tools/_commands.cjs');

const CLI_SEARCH_TOOL = 'knowledge-search';

test('R9DOC-1: knowledge-search is in SEARCH_TOOLS and LEDGER_VERIFIED_SEARCH_TOOLS', () => {
  assert.ok(
    loop.SEARCH_TOOLS.includes(CLI_SEARCH_TOOL),
    'SEARCH_TOOLS must accept the knowledge-search CLI subcommand',
  );
  assert.ok(
    loop.LEDGER_VERIFIED_SEARCH_TOOLS.includes(CLI_SEARCH_TOOL),
    'knowledge-search must be ledger-verified so a fabricated claim cannot pass',
  );
});

test('R9DOC-2: knowledge-search is a registered np-tools command', () => {
  const names = COMMANDS.map((c) => c && c.name);
  assert.ok(
    names.includes(CLI_SEARCH_TOOL),
    'knowledge-search must be a registered command so audited agents can run it via Bash',
  );
});

test('R9DOC-3: execute-phase.md names the knowledge-search CLI as the Rule 9 satisfier', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, 'workflows', 'execute-phase.md'), 'utf-8');
  assert.ok(
    wf.includes(CLI_SEARCH_TOOL),
    'execute-phase.md must reference the knowledge-search CLI so the orchestrator stamps the right tool',
  );
});

test('R9DOC-4: every audited agent doc references the knowledge-search CLI', () => {
  for (const agent of loop.AUDITED_AGENTS) {
    const docPath = path.join(REPO_ROOT, 'agents', agent + '.md');
    const doc = fs.readFileSync(docPath, 'utf-8');
    assert.ok(
      doc.includes(CLI_SEARCH_TOOL),
      agent + '.md must tell the agent to run knowledge-search for Rule 9',
    );
  }
});

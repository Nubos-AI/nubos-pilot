const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'workflows');

const { initWorkflows, topLevelCommands } = require(path.join(REPO_ROOT, 'np-tools.cjs'));

const BUILTIN_TOPLEVEL = new Set([
  'init', 'state', 'help', 'askuser',
]);

const KNOWN_COMMANDS = new Set([
  ...Object.keys(initWorkflows),
  ...Object.keys(topLevelCommands),
  ...BUILTIN_TOPLEVEL,
  // User-facing workflow aliases that map to milestone-scoped init commands
  'plan-phase', 'execute-phase', 'validate-phase',
]);

const LEGACY_MISSING_FRONTMATTER = new Set([
  'doctor.md', 'help.md', 'state.md',
]);

const LEGACY_COMMAND_FILENAME_OVERRIDES = new Set();

// Toggles declared in the schema + defaults but read by nobody — the defect
// class of `agents.parallelization`. Empty since 2026-07-17: parallelization,
// research, plan_checker and verifier are all wired now (see WFL-17 for where).
// A future toggle added without a reader lands here with a reason, or WFL-16
// fails — it must never grow silently.
const KNOWN_UNWIRED_AGENT_TOGGLES = new Set();

// The owning workflow for each wired agents.* toggle plus how it is enforced:
//   'shell' — a real `[ "$VAR" = … ]` branch in the workflow.
//   'prose' — an ACTION CONTRACT the orchestrator interprets. `parallelization`
//             is prose-guarded because bash cannot express parallel dispatch; the
//             contract, not a branch, decides how the wave is dispatched.
// Positive counterpart to KNOWN_UNWIRED: it pins WHERE the wiring lives, so
// deleting the guard fails WFL-17 rather than silently reverting the toggle to
// dead. Every boolean agents.* default must appear here or in KNOWN_UNWIRED
// (enforced by WFL-17b) — including architect/test_writer, whose shell guards
// live in execute-phase.md.
const WIRED_AGENT_TOGGLES = {
  parallelization: { file: 'execute-phase.md', kind: 'prose' },
  architect: { file: 'execute-phase.md', kind: 'shell' },
  test_writer: { file: 'execute-phase.md', kind: 'shell' },
  research: { file: 'plan-phase.md', kind: 'shell' },
  plan_checker: { file: 'plan-phase.md', kind: 'shell' },
  verifier: { file: 'verify-work.md', kind: 'shell' },
};

const LEGACY_UNKNOWN_COMMAND_REFERENCES = new Set();

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

test('WFL-8: discuss-phase spawns np-sc-extractor and persists via update-phase-meta', () => {
  const file = path.join(WORKFLOWS_DIR, 'discuss-phase.md');
  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(raw.includes('np-sc-extractor'),
    'discuss-phase must spawn np-sc-extractor so roadmap.yaml success_criteria get populated');
  assert.ok(raw.includes('update-phase-meta'),
    'discuss-phase must reference update-phase-meta as the persistence helper');
});

test('WFL-9: plan-phase Gate 1b blocks on empty success_criteria', () => {
  const file = path.join(WORKFLOWS_DIR, 'plan-phase.md');
  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(raw.includes('success_criteria.length == 0') || raw.includes('Empty success_criteria'),
    'plan-phase must guard against empty success_criteria (otherwise verify-work downstream blocks)');
});

test('WFL-10: np-sc-extractor agent file exists and matches workflow contract', () => {
  const agentPath = path.join(REPO_ROOT, 'agents', 'np-sc-extractor.md');
  assert.ok(fs.existsSync(agentPath), 'agents/np-sc-extractor.md must exist');
  const raw = fs.readFileSync(agentPath, 'utf-8');
  assert.ok(/name:\s*np-sc-extractor/.test(raw), 'frontmatter name must be np-sc-extractor');
  assert.ok(raw.includes('update-phase-meta'), 'agent must call update-phase-meta to persist SCs');
});

// P1.1: the whole verify step lived between `VERIFY_LOG=…` and `VERIFY_EXIT=$?`
// as a `#` comment, so the exit code captured was that of the assignment —
// always 0. Verify never ran, spawn-build-fixer was unreachable, and
// loop-commit's `verify_exit_code === 0` precondition was vacuously satisfied.
// D6: these lints used to flatten every ```bash fence into one context-free line
// list, so they could only ask "does this string appear ANYWHERE?". That let
// `["if false; then", 'bash -c "$VERIFY_CMD"', "fi"]` pass WFL-11 and let
// `VERIFY_EXIT="$?"` pass WFL-12. Keep the fences separate: a shell variable does
// not survive a fence boundary (that is D3), and adjacency is what WFL-12 checks.
function _executeBashBlocks() {
  const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
  return [...raw.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].split('\n'));
}

// Meaningful = executable: blanks and `#` comments carry no shell semantics, so
// dropping them is what makes "the next line" a statement about execution order.
function _meaningful(lines) {
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function _executeBashLines() {
  return _executeBashBlocks().flatMap(_meaningful);
}

// The verify run, whatever flags it carries: `bash -c`, `bash -ec`,
// `bash -eo pipefail -c`. Matching the flags loosely here is deliberate — WFL-11b
// is what asserts WHICH flags are required; this only has to find the line.
// Flag tokens may carry arguments (`-o pipefail`), hence \S+ rather than -\S+.
const VERIFY_RUN_RE = /^bash\s+((?:\S+\s+)*?)(-\S*c)\s+"\$VERIFY_CMD"/;

// The one fence that runs the verify command — the subject of WFL-11..13.
function _verifyBlock() {
  const block = _executeBashBlocks().find((b) => b.some((l) => VERIFY_RUN_RE.test(l.trim())));
  assert.ok(block, 'no ```bash fence runs `bash -c "$VERIFY_CMD"` — verify is not executed at all');
  return _meaningful(block);
}

test('WFL-11: the verify command runs unconditionally inside the pass@k loop (P1.1, D6)', () => {
  const lines = _verifyBlock();
  assert.ok(lines.some((l) => /VERIFY_CMD=\$\(.*task-verify-cmd/.test(l)),
    'VERIFY_CMD must be obtained from the task-verify-cmd verb — it was previously never defined');

  // Structural, not "appears somewhere": the run must be the FIRST statement of
  // the pass@k while-loop body. A dead `if false; then` wrapper, a guard, or any
  // other interposed statement breaks this — string presence alone would not.
  const idxWhile = lines.findIndex((l) => /^while\s+\[\s*"\$i"\s+-le\s+"\$VERIFY_RUNS"\s*\]/.test(l));
  assert.ok(idxWhile >= 0,
    'the pass@k loop must iterate over "$VERIFY_RUNS" directly (no ${VERIFY_RUNS:-1} default-masking)');
  const run = lines[idxWhile + 1] || '';
  assert.ok(VERIFY_RUN_RE.test(run) && /"\$VERIFY_CMD"\s+>>"\$VERIFY_LOG"\s+2>&1$/.test(run),
    'the verify run must be the first statement in the pass@k loop body, redirecting into $VERIFY_LOG. Got: ' + run);
});

test('WFL-11b: verify runs under `set -e` so a red line in a multi-line block is not swallowed (D2)', () => {
  const run = _verifyBlock().find((l) => VERIFY_RUN_RE.test(l));
  const m = run.match(VERIFY_RUN_RE);
  // Everything between `bash` and the -c that introduces the command string.
  const head = m[1] + m[2];
  assert.ok(/-\S*e/.test(head),
    'plain `bash -c` returns only the LAST line\'s exit code: `bash -c "$(printf \'false\\ntrue\\n\')"` is rc=0, ' +
    'so the first red line vanishes. Multi-line verify blocks are supported (TVC-1/TVC-17), ' +
    'so the shell must run with -e. Got: ' + run);
  assert.ok(/pipefail/.test(head),
    'a piped verify (`npm test | grep -q ok`) masks the failure without -o pipefail. Got: ' + run);
});

test('WFL-12: VERIFY_EXIT never comes from a bare $?; RC is captured adjacent to the run (P1.1, D6)', () => {
  const lines = _executeBashLines();
  // Every shape of the original bug, not just the exact `VERIFY_EXIT=$?` spelling:
  // quoted (`VERIFY_EXIT="$?"`) and trailing-comment variants used to slip past.
  const bare = lines.filter((l) => /^VERIFY_EXIT=\s*(?:"\$\?"|'\$\?'|\$\?)\s*(?:#.*)?$/.test(l));
  assert.deepEqual(bare, [],
    'a bare `VERIFY_EXIT=$?` captures whatever ran last; the exit code must come from the verify run itself');

  // The positional check the test name has always promised, now actually run:
  // `RC=$?` is only meaningful DIRECTLY after the verify run. One statement in
  // between (a log line, an echo) and it captures that statement's status.
  const block = _verifyBlock();
  const idxRun = block.findIndex((l) => VERIFY_RUN_RE.test(l));
  assert.ok(idxRun >= 0);
  assert.match(block[idxRun + 1] || '', /^RC=\$\?$/,
    'the per-run exit code must be captured on the line immediately after the verify run');
  // The general defect class, not just the verify instance: `$?` captured under
  // a plain assignment reads the ASSIGNMENT's status (always 0), never a command's.
  // That is exactly how P1.1 shipped: `VERIFY_LOG=…` then `VERIFY_EXIT=$?`.
  // A command-substitution assignment (`X=$(cmd)`) does propagate cmd's status,
  // so it is a legitimate predecessor.
  const strays = block.filter((l, i) => {
    if (!/^\w+=\s*"?\$\?"?\s*(?:#.*)?$/.test(l)) return false;
    const prev = block[i - 1] || '';
    return /^\w+=/.test(prev) && !prev.includes('$(');
  });
  assert.deepEqual(strays, [],
    'a `$?` capture directly under a plain assignment reads the assignment\'s status (always 0), ' +
    'not a command\'s — this is the P1.1 bug shape');

  assert.ok(block.some((l) => /^VERIFY_EXIT=/.test(l)),
    'VERIFY_EXIT must be derived in the same fence as the run');
});

test('WFL-13: $VERIFY_RUNS is resolved in the fence that consumes it, with no silent default (P1.1, D3)', () => {
  const block = _verifyBlock();
  assert.ok(block.some((l) => /verify-reliability\s+--codes/.test(l)),
    'verify-reliability is implemented and registered but had no caller outside a comment');

  // D3: VERIFY_RUNS used to be set in the Initialize fence and read here — a
  // different shell process. It arrived unset, and `${VERIFY_RUNS:-1}` silently
  // downgraded pass@k to a single run. Repo convention is silent → loud.
  const idxSrc = block.findIndex((l) => /^VERIFY_RUNS=\$\(.*config-get\s+loop\.verify_runs/.test(l));
  assert.ok(idxSrc >= 0,
    'VERIFY_RUNS must be re-read from `config-get loop.verify_runs` in this fence — a shell variable ' +
    'does not survive a ```bash fence boundary, and pass@k silently became pass@1');
  const idxUse = block.findIndex((l) => /\$VERIFY_RUNS/.test(l) && !/^VERIFY_RUNS=/.test(l));
  assert.ok(idxUse > idxSrc, 'VERIFY_RUNS must be resolved before it is consumed');

  const masked = block.filter((l) => /\$\{VERIFY_RUNS:-[^}]*\}/.test(l));
  assert.deepEqual(masked, [],
    '`${VERIFY_RUNS:-1}` masks an unset variable as a healthy pass@1 — validate loudly instead');
  assert.ok(block.some((l) => /VERIFY_RUNS/.test(l) && /exit\s+1/.test(l))
    || block.some((l, i) => /case\s+"\$VERIFY_RUNS"\s+in/.test(l) && block.slice(i, i + 4).some((n) => /exit\s+1/.test(n))),
    'a non-numeric / zero loop.verify_runs must abort loudly, not fall back to 1');
});

// D4: `case "$NEXT_ACTION" in` had no `*)` arm. When `loop-run-round --phase
// post-critics` fails (loop-post-critics-round-shifted, spawn-evidence missing,
// -invalid-json, -empty-outputs), POST_CRIT is empty, JSON.parse throws, and
// NEXT_ACTION is "" — which matched no arm, fell through `esac`, and re-entered
// the while-loop at an UNCHANGED $ROUND: an unbounded executor+critic spawn loop.
// The two `*)` arms that did exist guarded the INNER askuser dialogs only, and
// their own comments describe exactly this bug 20 lines below where it lived.
function _caseArms(lines, subject) {
  const start = lines.findIndex((l) => new RegExp('^case\\s+"\\' + subject + '"\\s+in$').test(l));
  assert.ok(start >= 0, 'no `case "' + subject + '" in` found in execute-phase.md');
  const arms = [];
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^case\s+.*\sin$/.test(l)) { depth += 1; continue; }
    if (/^esac\b/.test(l)) { depth -= 1; if (depth === 0) return arms; continue; }
    if (depth === 1) {
      const m = l.match(/^([^)\s][^)]*)\)/);
      if (m) arms.push(m[1].trim());
    }
  }
  assert.fail('unterminated `case "' + subject + '"` — no matching esac');
  return arms;
}

test('WFL-14: the NEXT_ACTION dispatch has a default arm — no silent fall-through into an unbounded loop (D4)', () => {
  const arms = _caseArms(_executeBashLines(), '$NEXT_ACTION');
  assert.ok(arms.includes('commit'), 'sanity: the commit arm must still exist (found: ' + arms.join(', ') + ')');
  assert.ok(arms.includes('*'),
    'the OUTER `case "$NEXT_ACTION"` needs a `*)` arm. Without it an unroutable value ' +
    '(empty string when post-critics fails) falls through esac and re-enters the while-loop ' +
    'at the same $ROUND forever. Arms present: ' + arms.join(', '));
});

test('WFL-15: an empty NEXT_ACTION is caught before the dispatch, not routed (D4)', () => {
  const lines = _executeBashLines();
  const idxCase = lines.findIndex((l) => /^case\s+"\$NEXT_ACTION"\s+in$/.test(l));
  assert.ok(idxCase >= 0);
  // The better guard: a tool failure yields "" long before it is a routing
  // question. Catch it at the source rather than let `*)` be the only net.
  const guard = lines.slice(0, idxCase).some((l, i, a) => /^\[\s*-z\s+"\$NEXT_ACTION"\s*\]/.test(l)
    || (/^if\s+\[\s*-z\s+"\$NEXT_ACTION"\s*\]/.test(l) && a.slice(i, i + 4).some((n) => /exit\s+1/.test(n))));
  assert.ok(guard,
    'an empty $NEXT_ACTION (post-critics failed / emitted invalid JSON) must abort loudly before ' +
    'reaching the case dispatch');
});

test('WFL-16: every agents.* toggle that config-defaults declares is honoured somewhere', () => {
  // `agents.parallelization` sat in the schema and the defaults with a documented
  // "runs tasks serially" effect and an FAQ entry telling operators when to use
  // it — and nothing read it. A toggle that reads as a supported kill-switch but
  // switches nothing is worse than an absent one: it is a promise the tool breaks
  // in exactly the constrained environment the operator reached for it.
  const { DEFAULT_AGENTS } = require(path.join(REPO_ROOT, 'lib', 'config-defaults.cjs'));

  // Strip comments before searching. A mention of `agents.foo` in a comment —
  // e.g. "TODO: nobody reads agents.foo" in the very file that declares it, the
  // most natural place to write it — would otherwise satisfy this guard and
  // silently kill it. Only a real read counts.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const stripBash = (s) => s.replace(/(^|\s)#[^\n]*/g, '$1');

  const haystack = [
    ...fs.readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => stripBash(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8'))),
    ...['lib', 'bin'].flatMap((dir) => {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
        const p = path.join(d, e.name);
        if (e.isDirectory()) return walk(p);
        if (!/\.(cjs|js)$/.test(e.name) || /\.test\.cjs$/.test(e.name)) return [];
        return [strip(fs.readFileSync(p, 'utf-8'))];
      });
      return walk(path.join(REPO_ROOT, dir));
    }),
  ].join('\n');

  // Require a *read-like* occurrence, not a bare substring. A diagnostic
  // `echo "… agents.verifier=false …"` contains `agents.verifier` and would
  // otherwise mask a deleted `config-get agents.verifier`. A real read is either
  // `config-get agents.X` (workflows) or a quoted `'agents.X'` path literal
  // (lib/bin: readConfigPath / the loop-run-round routing table).
  // Only boolean toggles: `economy` is a string enum read via bare property
  // access in lib/economy-mode.cjs (own tests), not through this surface.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isRead = (key) => new RegExp(
    `config-get agents\\.${esc(key)}\\b|['"\`]agents\\.${esc(key)}['"\`]`,
  ).test(haystack);
  const dead = Object.keys(DEFAULT_AGENTS)
    .filter((key) => typeof DEFAULT_AGENTS[key] === 'boolean')
    .filter((key) => !KNOWN_UNWIRED_AGENT_TOGGLES.has(key))
    .filter((key) => !isRead(key));

  assert.deepEqual(dead, [], `agents.* toggles declared but read by nobody: ${dead.join(', ')}`);
});

test('WFL-16b: the unwired-toggle debt list does not rot', () => {
  const { DEFAULT_AGENTS } = require(path.join(REPO_ROOT, 'lib', 'config-defaults.cjs'));
  for (const key of KNOWN_UNWIRED_AGENT_TOGGLES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_AGENTS, key),
      `stale entry '${key}' — no longer in DEFAULT_AGENTS, drop it from the list`,
    );
  }
  // Wiring one of these must shrink the list, not leave a lie behind.
  const workflows = fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8'))
    .join('\n');
  for (const key of KNOWN_UNWIRED_AGENT_TOGGLES) {
    assert.ok(
      !workflows.includes(`config-get agents.${key}`),
      `agents.${key} is wired now — remove it from KNOWN_UNWIRED_AGENT_TOGGLES`,
    );
  }
});

test('WFL-17: each wired agents.* toggle is both read and acted on in its owning workflow', () => {
  // WFL-16 proves a toggle is read *somewhere*; this proves the read lives in the
  // workflow that owns the behaviour AND that something acts on it — a `config-get`
  // whose result is never used would pass WFL-16 but still be dead.
  const { DEFAULT_AGENTS } = require(path.join(REPO_ROOT, 'lib', 'config-defaults.cjs'));
  // Strip bash comments so a mere `# … $VAR …` comment cannot pose as a guard —
  // the exact hole a prior version of this test left open.
  const stripBash = (s) => s.replace(/(^|\s)#[^\n]*/g, '$1');

  for (const [key, { file, kind }] of Object.entries(WIRED_AGENT_TOGGLES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_AGENTS, key),
      `WIRED_AGENT_TOGGLES names agents.${key}, which is not in DEFAULT_AGENTS`,
    );
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
    assert.ok(
      src.includes(`config-get agents.${key}`),
      `${file} must read agents.${key} via config-get`,
    );
    const enabledVar = new RegExp(
      `([A-Z_]+)=\\$\\(node[^\\n]*config-get agents\\.${key}`,
    ).exec(src);
    assert.ok(enabledVar, `${file}: agents.${key} read must be captured in a shell var`);
    const v = enabledVar[1];

    if (kind === 'shell') {
      // A real shell test on the captured var, comments removed so a comment
      // that merely names the var cannot satisfy this.
      assert.ok(
        new RegExp(`\\[\\s*"\\$\\{?${v}\\}?"\\s*(?:=|!=)`).test(stripBash(src)),
        `${file}: $${v} is read but never used in a shell test — the toggle does nothing`,
      );
    } else {
      // Prose-guarded (parallelization): the var must be bound to an ACTION
      // CONTRACT — the contract the orchestrator interprets IS the guard. A stray
      // mention elsewhere does not count; it must sit inside the contract.
      assert.ok(
        new RegExp(`ACTION CONTRACT[\\s\\S]{0,800}\\$${v}\\b`).test(src),
        `${file}: $${v} is not bound to an ACTION CONTRACT — a prose-guarded toggle needs the contract that acts on it`,
      );
    }
  }
});

test('WFL-17b: every boolean agents.* toggle is categorised (wired or known-unwired)', () => {
  // Completeness gate. Without it a toggle can have the strongest possible guard
  // (architect/test_writer's shell branches) yet escape WFL-17 entirely just by
  // not being listed — and a brand-new toggle would silently fall under WFL-16's
  // weaker "read somewhere" rule alone. Force every boolean default into exactly
  // one bucket. `economy` is a string enum, out of scope here.
  const { DEFAULT_AGENTS } = require(path.join(REPO_ROOT, 'lib', 'config-defaults.cjs'));
  const boolKeys = Object.keys(DEFAULT_AGENTS).filter((k) => typeof DEFAULT_AGENTS[k] === 'boolean');
  const covered = new Set([...Object.keys(WIRED_AGENT_TOGGLES), ...KNOWN_UNWIRED_AGENT_TOGGLES]);

  const uncategorised = boolKeys.filter((k) => !covered.has(k));
  assert.deepEqual(
    uncategorised, [],
    `boolean agents.* toggles in neither WIRED_AGENT_TOGGLES nor KNOWN_UNWIRED_AGENT_TOGGLES: ${uncategorised.join(', ')}`,
  );
  for (const k of Object.keys(WIRED_AGENT_TOGGLES)) {
    assert.ok(boolKeys.includes(k), `WIRED_AGENT_TOGGLES has '${k}', not a boolean agents.* default`);
  }
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

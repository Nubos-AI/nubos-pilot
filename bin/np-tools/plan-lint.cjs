'use strict';


const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const { tryReadConfigPath } = require('../../lib/config.cjs');
const { extractFrontmatter } = require('../../lib/frontmatter.cjs');
const planLint = require('../../lib/plan-lint.cjs');
const { extractVerifyBlocks } = require('../../lib/verify-block.cjs');
const args = require('./_args.cjs');

const MILESTONE_RE = /^M\d{3,}$/;

// ---------------------------------------------------------------------------
// plan_lint.verify_allow_commands — the project's seam into the deny-by-default
// <verify> allow-list (ADR-0019).
//
// nubos-pilot is a product for arbitrary foreign projects, so the compiled
// allow-list in lib/plan-lint.cjs cannot be complete by construction: a project
// on `just`, `bazel` or `mise` would get a critical `verify-command-not-allowed`
// on every plan with no way to answer it. lintVerifyCommands has always read
// `opts.allowExtraCommands` — this is the caller that finally supplies it.
//
// It widens the allow-list; it must never narrow the deny-list. See
// NON_OVERRIDABLE_COMMANDS.
// ---------------------------------------------------------------------------
const ALLOW_COMMANDS_KEY = 'plan_lint.verify_allow_commands';

// A bare command name: what the lexer in lib/plan-lint.cjs compares against.
// No slashes (a path is not an allow-list entry — it is checked for existence),
// no whitespace, no shell metacharacters.
const ALLOW_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// A project may add its own tools. It may not switch off the network/shell-escape
// schranke: `verify_allow_commands: ["curl"]` or `["bash"]` is refused, not
// honoured. Deliberately an error rather than a silent no-op — a config that
// looks like it disabled a security gate must not be left standing.
// Every name here is handled *before* the allow-list is consulted, so listing
// one would be a dead letter that reads like an opened boundary. All four sets
// come from lib/plan-lint.cjs by reference — a copy here would drift.
const NON_OVERRIDABLE_COMMANDS = Object.freeze(new Set([
  ...planLint.VERIFY_SHELLS,
  ...planLint.VERIFY_INTERPRETERS.keys(),
  ...planLint.VERIFY_DENIED_COMMANDS.keys(),
  ...planLint.VERIFY_FORWARDERS.keys(),
]));

function _resolveAllowExtraCommands(cwd) {
  // An unreadable/unparseable config.json falls back to `[]` (with a warning
  // from lib/config.cjs) — the empty allow-list is the fail-closed direction.
  // A *present but wrong* value is a different story: it is a deliberate
  // statement about a security gate, so it fails loudly instead.
  const raw = tryReadConfigPath(cwd, ALLOW_COMMANDS_KEY, []);
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new NubosPilotError(
      'plan-lint-invalid-allow-list',
      ALLOW_COMMANDS_KEY + ' must be an array of bare command names',
      { key: ALLOW_COMMANDS_KEY, received: typeof raw },
    );
  }
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !ALLOW_COMMAND_RE.test(entry.trim())) {
      throw new NubosPilotError(
        'plan-lint-invalid-allow-list',
        ALLOW_COMMANDS_KEY + ' entries must be bare command names (e.g. "just", "bazel") — '
          + 'not paths, arguments or shell fragments',
        {
          key: ALLOW_COMMANDS_KEY,
          entry: typeof entry === 'string' ? entry.slice(0, 60) : typeof entry,
        },
      );
    }
    const name = entry.trim();
    if (NON_OVERRIDABLE_COMMANDS.has(name)) {
      throw new NubosPilotError(
        'plan-lint-allow-command-not-overridable',
        '"' + name + '" cannot be added to ' + ALLOW_COMMANDS_KEY + '. The key registers a '
          + "project's own tools; it does not disable the <verify> deny-list (network "
          + 'clients, shells, interpreters, privilege escalation, mutation).',
        { key: ALLOW_COMMANDS_KEY, entry: name },
      );
    }
    out.push(name);
  }
  return out;
}

function _walkMilestonePlans(milestoneDir) {
  const out = [];
  if (!fs.existsSync(milestoneDir)) return out;
  const mPlan = fs.readdirSync(milestoneDir)
    .filter((f) => /^M\d{3,}-PLAN\.md$/.test(f))
    .map((f) => path.join(milestoneDir, f));
  out.push(...mPlan);
  const slicesDir = path.join(milestoneDir, 'slices');
  if (fs.existsSync(slicesDir)) {
    const slices = fs.readdirSync(slicesDir).filter((d) => /^S\d{3,}$/.test(d)).sort();
    for (const sId of slices) {
      const sDir = path.join(slicesDir, sId);
      for (const f of fs.readdirSync(sDir)) {
        if (/^S\d{3,}-PLAN\.md$/.test(f)) out.push(path.join(sDir, f));
      }
      const tasksDir = path.join(sDir, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      const tasks = fs.readdirSync(tasksDir).filter((d) => /^T\d{4,}$/.test(d)).sort();
      for (const tId of tasks) {
        const tDir = path.join(tasksDir, tId);
        for (const f of fs.readdirSync(tDir)) {
          if (/^T\d{4,}-PLAN\.md$/.test(f)) out.push(path.join(tDir, f));
        }
      }
    }
  }
  return out;
}

function _planKind(planPath) {
  const base = path.basename(planPath);
  if (/^T\d{4,}-PLAN\.md$/.test(base)) return 'task';
  if (/^S\d{3,}-PLAN\.md$/.test(base)) return 'slice';
  if (/^M\d{3,}-PLAN\.md$/.test(base)) return 'milestone';
  return 'slice';
}

function _sliceTaskCollect(milestoneDir) {
  const out = []; // [{ slice, tasks: [{id, files_modified, depends_on, verifyText}] }]
  const slicesDir = path.join(milestoneDir, 'slices');
  if (!fs.existsSync(slicesDir)) return out;
  const slices = fs.readdirSync(slicesDir).filter((d) => /^S\d{3,}$/.test(d)).sort();
  for (const sId of slices) {
    const tasksDir = path.join(slicesDir, sId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    const tasks = fs.readdirSync(tasksDir).filter((d) => /^T\d{4,}$/.test(d)).sort();
    const collected = [];
    for (const tId of tasks) {
      const taskDir = path.join(tasksDir, tId);
      const planFile = fs.readdirSync(taskDir).find((f) => /^T\d{4,}-PLAN\.md$/.test(f));
      if (!planFile) continue;
      const raw = fs.readFileSync(path.join(taskDir, planFile), 'utf-8');
      const { frontmatter, body } = extractFrontmatter(raw);
      // D5: this was a private, non-`g` copy of the SSOT regex, so verifyText
      // stopped after the FIRST <verify> block. A working-tree-reading check in
      // any later block was invisible to lintParallelTaskRaces — a `critical`
      // race finding that could not fire. lib/plan-lint.cjs already reads every
      // block via the SSOT; the two must not drift again.
      const verifyText = extractVerifyBlocks(body).map((b) => b.body).join('\n');
      collected.push({
        id: (frontmatter && frontmatter.id) || tId,
        files_modified: (frontmatter && Array.isArray(frontmatter.files_modified))
          ? frontmatter.files_modified : [],
        depends_on: (frontmatter && Array.isArray(frontmatter.depends_on))
          ? frontmatter.depends_on : [],
        verifyText,
        slice: sId,
      });
    }
    if (collected.length) out.push({ slice: sId, tasks: collected });
  }
  return out;
}

function _summarize(filesResult, raceFindings) {
  const counts = { critical: 0, major: 0, minor: 0, total: 0 };
  for (const f of filesResult) {
    for (const finding of f.findings) {
      counts.total += 1;
      counts[finding.severity || 'minor'] = (counts[finding.severity || 'minor'] || 0) + 1;
    }
  }
  for (const finding of raceFindings) {
    counts.total += 1;
    counts[finding.severity || 'minor'] = (counts[finding.severity || 'minor'] || 0) + 1;
  }
  return counts;
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];

  const milestoneFlag = args.getFlag(list, '--milestone');
  const positional = list.filter((a) => !String(a).startsWith('--'));
  const targetPath = positional[0];

  let filePaths = [];
  let raceInputs = [];

  if (milestoneFlag) {
    if (!MILESTONE_RE.test(milestoneFlag)) {
      throw new NubosPilotError(
        'plan-lint-invalid-milestone',
        '--milestone expects M<NNN> form (e.g. M004)',
        { got: milestoneFlag },
      );
    }
    const root = findProjectRoot(cwd);
    const mDir = path.join(root, '.nubos-pilot', 'milestones', milestoneFlag);
    if (!fs.existsSync(mDir)) {
      throw new NubosPilotError(
        'plan-lint-milestone-not-found',
        'milestone directory does not exist: ' + mDir,
        { milestone: milestoneFlag, path: mDir },
      );
    }
    filePaths = _walkMilestonePlans(mDir);
    raceInputs = _sliceTaskCollect(mDir);
  } else if (targetPath) {
    const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
    if (!fs.existsSync(abs)) {
      throw new NubosPilotError(
        'plan-lint-file-not-found',
        'plan file not found: ' + targetPath,
        { path: abs },
      );
    }
    filePaths = [abs];
  } else {
    throw new NubosPilotError(
      'plan-lint-missing-target',
      'plan-lint requires a path argument OR --milestone <M<NNN>>',
      { hint: 'examples: `plan-lint M004-S001-PLAN.md` or `plan-lint --milestone M004`' },
    );
  }

  const allowExtraCommands = _resolveAllowExtraCommands(cwd);

  const filesResult = filePaths.map((p) => {
    const raw = fs.readFileSync(p, 'utf-8');
    const { body } = extractFrontmatter(raw);
    return {
      path: path.relative(cwd, p),
      findings: planLint.lintPlan(body, {
        cwd, raw, allowExtraCommands, planKind: _planKind(p),
      }),
    };
  });

  let raceFindings = [];
  for (const group of raceInputs) {
    raceFindings.push(...planLint.lintParallelTaskRaces(group.tasks));
  }

  const summary = _summarize(filesResult, raceFindings);
  const payload = {
    target: milestoneFlag || (positional[0] || null),
    summary,
    files: filesResult,
    parallel_race_findings: raceFindings,
  };
  stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return summary.critical > 0 ? 2 : 0;
}

module.exports = { run, NON_OVERRIDABLE_COMMANDS, ALLOW_COMMANDS_KEY };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

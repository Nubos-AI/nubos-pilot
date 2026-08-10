'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { safeYamlParse } = require('../../lib/yaml.cjs');
const manifestMod = require('../../lib/install/manifest.cjs');
const codexTomlMod = require('../../lib/install/codex-toml.cjs');
const runtimeAssetsMod = require('../../lib/install/runtime-assets.cjs');
const askuserMod = require('../../lib/askuser.cjs');
const codebaseManifest = require('../../lib/codebase-manifest.cjs');
const { scan: workspaceScan } = require('../../lib/workspace-scan.cjs');
const outputLint = require('../../lib/output-lint.cjs');
const { getSchema, inferSchemaForFile } = require('../../lib/schemas/index.cjs');
const layout = require('../../lib/layout.cjs');
const verify = require('../../lib/verify.cjs');
const { readMilestoneMeta } = require('../../lib/milestone-meta.cjs');
const rollup = require('../../lib/rollup.cjs');
const { isDoneMilestoneStatus } = require('../../lib/roadmap-schema.cjs');

const PAYLOAD_SUBPATH = path.join('.claude', 'nubos-pilot');
const STATE_SUBPATH = '.nubos-pilot';
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const OPENCODE_LOCAL_PREFIX = '.opencode/nubos-pilot/';

function _readScope(projectRoot) {
  const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
  let cfg;
  try {
    cfg = readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return 'local';
    if (err && _CONFIG_PARSE_CODES.has(err.code)) return 'local';
    throw err;
  }
  return cfg && cfg.scope === 'global' ? 'global' : 'local';
}

function _payloadBaseFor(projectRoot, scope) {
  return scope === 'global' ? os.homedir() : projectRoot;
}

function _payloadDirFor(projectRoot, scope) {
  return path.join(_payloadBaseFor(projectRoot, scope), PAYLOAD_SUBPATH);
}

function _resolveManifestEntry(rel, projectRoot, scope) {
  if (rel.startsWith('~/')) {
    return path.join(os.homedir(), rel.slice(2));
  }
  const base = _payloadBaseFor(projectRoot, scope);
  if (runtimeAssetsMod.isAssetManifestKey(rel) || rel.startsWith(OPENCODE_LOCAL_PREFIX)) {
    return path.join(base, rel);
  }
  return path.join(_payloadDirFor(projectRoot, scope), rel);
}

function _pkgVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function _checkManifestIntegrity(projectRoot, scope) {
  const issues = [];
  const payloadDir = _payloadDirFor(projectRoot, scope);
  let manifest = null;
  try {
    manifest = manifestMod.readManifest(payloadDir);
  } catch (err) {
    issues.push({
      id: 'missing-manifest',
      severity: 'error',
      fixable: 'reinstall',
      details: { reason: 'parse-failed', cause: err && err.message },
    });
    return { manifest: null, issues };
  }
  if (!manifest) {
    issues.push({
      id: 'missing-manifest',
      severity: 'error',
      fixable: 'reinstall',
      details: { payloadDir },
    });
    return { manifest: null, issues };
  }
  const files = (manifest.files && typeof manifest.files === 'object') ? manifest.files : {};
  for (const rel of Object.keys(files)) {
    const full = _resolveManifestEntry(rel, projectRoot, scope);
    if (!fs.existsSync(full)) {
      issues.push({
        id: 'payload-missing',
        file: rel,
        severity: 'error',
        fixable: 'reinstall',
      });
      continue;
    }
    let hash;
    try { hash = manifestMod.fileHashSync(full); } catch { hash = null; }
    if (hash && hash !== files[rel]) {
      issues.push({
        id: 'payload-modified',
        file: rel,
        severity: 'warn',
        fixable: 'reinstall',
      });
    }
  }
  return { manifest, issues };
}

function _checkVersionMismatch(manifest) {
  if (!manifest) return [];
  const installed = String(manifest.version == null ? '' : manifest.version);
  const pkg = String(_pkgVersion());
  if (installed && installed !== pkg) {
    return [{
      id: 'version-mismatch',
      severity: 'warn',
      fixable: 'reinstall',
      details: { installed, expected: pkg },
    }];
  }
  return [];
}

function _checkHooksMissing(manifest, payloadDir) {
  if (!manifest) return [];
  const files = (manifest.files && typeof manifest.files === 'object') ? manifest.files : {};
  const hasHooksEntries = Object.keys(files).some((rel) => rel.startsWith('hooks/'));
  if (!hasHooksEntries) return [];
  const hooksDir = path.join(payloadDir, 'hooks');
  if (fs.existsSync(hooksDir)) return [];
  return [{
    id: 'hooks-missing',
    severity: 'error',
    fixable: 'reinstall',
    details: { hooksDir },
  }];
}

function _checkCodexTrappedFeatures() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return { issues: [], content: null };
  let content;
  try {
    content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch (err) {
    return {
      issues: [{
        id: 'codex-trapped-features',
        severity: 'warn',
        fixable: 'reinstall',
        details: { reason: 'read-failed', cause: err && err.message },
      }],
      content: null,
    };
  }
  if (codexTomlMod.hasTrappedFeatures(content)) {
    return {
      issues: [{
        id: 'codex-trapped-features',
        severity: 'warn',
        fixable: 'auto',
        details: { path: CODEX_CONFIG_PATH },
      }],
      content,
    };
  }
  return { issues: [], content };
}

function _checkAskUserBroken() {
  try {
    askuserMod.getRuntime();
    return [];
  } catch (err) {
    return [{
      id: 'askuser-broken',
      severity: 'warn',
      fixable: 'prompt',
      details: { cause: err && err.message },
    }];
  }
}

function _checkCodebaseDocs(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) return issues;
  const codebaseDir = path.join(stateDir, 'codebase');
  const indexPath = path.join(codebaseDir, 'INDEX.md');
  const modulesDir = path.join(codebaseDir, 'modules');

  if (!fs.existsSync(indexPath)) {
    issues.push({
      id: 'codebase-not-scanned',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { hint: 'run `np:scan-codebase`' },
    });
    return issues;
  }

  let prevManifest;
  try {
    prevManifest = codebaseManifest.readManifest(projectRoot);
  } catch (err) {
    issues.push({
      id: 'codebase-manifest-unreadable',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { cause: err && err.code, hint: 'run `np:scan-codebase`' },
    });
    return issues;
  }

  let scanResult;
  try {
    scanResult = workspaceScan({ cwd: projectRoot, batchSize: 1000 });
  } catch (err) {
    issues.push({
      id: 'codebase-scan-failed',
      severity: 'warn',
      fixable: 'run-workflow',
      details: { cause: err && err.code, hint: 'inspect workspace and re-run `np:scan-codebase`' },
    });
    return issues;
  }

  const nextManifest = codebaseManifest.manifestFromScanFiles(scanResult.files);
  const diff = codebaseManifest.diffManifest(prevManifest, nextManifest);
  const touched = diff.summary.added + diff.summary.changed + diff.summary.removed;
  if (touched > 0) {
    issues.push({
      id: 'codebase-manifest-stale',
      severity: 'warn',
      fixable: 'run-workflow',
      details: {
        added: diff.summary.added,
        changed: diff.summary.changed,
        removed: diff.summary.removed,
        hint: 'run `np:update-docs`',
      },
    });
  }

  if (fs.existsSync(modulesDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.md'));
    } catch {}
    const tbdDocs = [];
    for (const f of entries) {
      try {
        const raw = fs.readFileSync(path.join(modulesDir, f), 'utf-8');
        const purposeIdx = raw.indexOf('## Purpose');
        if (purposeIdx >= 0) {
          const chunk = raw.slice(purposeIdx, purposeIdx + 400);
          if (chunk.includes('_TBD')) tbdDocs.push(f);
        }
      } catch {}
    }
    if (tbdDocs.length > 0) {
      issues.push({
        id: 'codebase-tbd-docs',
        severity: 'info',
        fixable: 'run-workflow',
        details: {
          count: tbdDocs.length,
          sample: tbdDocs.slice(0, 5),
          hint: 'run `np:scan-codebase` and dispatch the documenter agent for each module',
        },
      });
    }
  }

  return issues;
}

function _milestoneStatusDrift(doc, projectRoot) {
  const issues = [];
  for (const m of doc.milestones) {
    if (!m || m.id === 'backlog') continue;
    const num = Number(m.number);
    if (!Number.isInteger(num)) continue;
    const id = typeof m.id === 'string' ? m.id : layout.mId(num);

    const roadmapStatus = typeof m.status === 'string' ? m.status : 'pending';

    let metaStatus;
    try {
      const meta = readMilestoneMeta(num, projectRoot);
      metaStatus = meta && typeof meta.status === 'string' ? meta.status : null;
    } catch { metaStatus = null; }

    let derived = null;
    const verPath = verify.milestoneVerificationPath(num, projectRoot);
    if (fs.existsSync(verPath)) {
      try {
        derived = verify._roadmapStatusFromResults(verify.parseVerificationMd(verPath));
      } catch { derived = null; }
    }

    if (metaStatus !== null && metaStatus !== roadmapStatus) {
      let workComplete = null;
      try { workComplete = rollup.inspectMilestone(num, projectRoot).all_done; } catch { workComplete = null; }
      const roadmapIsFresher = workComplete === false && isDoneMilestoneStatus(metaStatus);
      issues.push({
        id: 'milestone-status-drift',
        severity: 'warn',
        fixable: 'run-command',
        details: {
          milestone: id,
          source: 'meta',
          roadmap_status: roadmapStatus,
          meta_status: metaStatus,
          hint: roadmapIsFresher
            ? 'M-META.json still reports "' + metaStatus + '" but the tasks on disk are '
              + 'no longer complete, so roadmap.yaml is the fresher side. Run `np-tools '
              + 'rollup ' + num + '` to bring META down, then re-run `/np:verify-work '
              + num + '` once the work is finished again. Do NOT run `verify-work '
              + 'sync-roadmap` here — it would promote roadmap.yaml back up.'
            : 'M-META.json disagrees with roadmap.yaml; the dashboard reads META. '
              + 'Run `np-tools verify-work sync-roadmap` to rewrite both from the SC verdicts.',
        },
      });
    }

    if (derived !== null && derived !== roadmapStatus) {
      issues.push({
        id: 'milestone-status-drift',
        severity: 'warn',
        fixable: 'run-command',
        details: {
          milestone: id,
          source: 'verification',
          roadmap_status: roadmapStatus,
          derived_status: derived,
          hint: 'the SC verdicts in VERIFICATION.md imply "' + derived + '". '
            + 'Run `np-tools verify-work sync-roadmap` to bring roadmap.yaml in line.',
        },
      });
    }
  }
  return issues;
}

function _rollupDrift(doc, projectRoot) {
  const issues = [];
  for (const m of doc.milestones) {
    if (!m || m.id === 'backlog') continue;
    const num = Number(m.number);
    if (!Number.isInteger(num)) continue;
    const id = typeof m.id === 'string' ? m.id : layout.mId(num);

    let inspected;
    try { inspected = rollup.inspectMilestone(num, projectRoot); } catch { continue; }

    for (const s of inspected.slices) {
      if (s.derived === null || s.persisted === s.derived) continue;
      issues.push({
        id: 'slice-status-drift',
        severity: 'warn',
        fixable: 'run-command',
        details: {
          milestone: id,
          slice: s.id,
          persisted_status: s.persisted,
          derived_status: s.derived,
          hint: 'the tasks on disk imply "' + s.derived + '". Run `np-tools rollup ' + num
            + '` to bring roadmap.yaml in line.',
        },
      });
    }

    if (isDoneMilestoneStatus(m.status) && inspected.slices.length > 0 && !inspected.all_done) {
      issues.push({
        id: 'milestone-terminal-with-open-work',
        severity: 'warn',
        fixable: 'run-command',
        details: {
          milestone: id,
          milestone_status: m.status,
          hint: 'milestone is "' + m.status + '" but not every slice is done — the '
            + 'verification it refers to is stale. Run `np-tools rollup ' + num
            + '` to reopen it, then re-run `/np:verify-work ' + num + '`.',
        },
      });
    }

    for (const sliceId of (inspected.fully_parked || [])) {
      issues.push({
        id: 'slice-fully-parked',
        severity: 'info',
        fixable: 'run-command',
        details: {
          milestone: id,
          slice: sliceId,
          hint: 'every task in ' + sliceId + ' is parked, so the slice can never complete. '
            + 'Unpark the tasks (`np-tools unpark <task-id>`) or skip them to close the slice.',
        },
      });
    }

    if ((inspected.invalid_slice_ids || []).length > 0) {
      issues.push({
        id: 'slice-id-out-of-shape',
        severity: 'warn',
        fixable: 'manual',
        details: {
          milestone: id,
          slice_ids: inspected.invalid_slice_ids,
          hint: 'slice ids must match S<NNN> (three digits or more) to resolve to a '
            + 'directory. These block their milestone from ever reading as complete.',
        },
      });
    }

    if (inspected.unreadable_tasks > 0) {
      issues.push({
        id: 'task-plan-unreadable',
        severity: 'warn',
        fixable: 'manual',
        details: {
          milestone: id,
          count: inspected.unreadable_tasks,
          hint: 'task directories exist whose PLAN.md is missing or carries no status. '
            + 'Their slices cannot complete until this is resolved.',
        },
      });
    }

    if (inspected.all_done) {
      const verPath = verify.milestoneVerificationPath(num, projectRoot);
      if (!fs.existsSync(verPath)) {
        issues.push({
          id: 'milestone-ready-for-verification',
          severity: 'info',
          fixable: 'run-workflow',
          details: {
            milestone: id,
            hint: 'every slice is done but no VERIFICATION.md exists — run `/np:verify-work '
              + num + '`. The milestone stays in-progress until verification classifies '
              + 'its success criteria; task completion alone never makes it terminal.',
          },
        });
      }
    }
  }
  return issues;
}

function _checkMilestoneLayout(projectRoot) {
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  const roadmapPath = path.join(stateDir, 'roadmap.yaml');
  if (!fs.existsSync(roadmapPath)) return [];
  let doc;
  try {
    doc = safeYamlParse(fs.readFileSync(roadmapPath, 'utf-8'), { kind: 'doctor-roadmap' });
  } catch {
    return [{
      id: 'roadmap-unreadable',
      severity: 'error',
      fixable: 'manual',
      details: { path: roadmapPath, hint: 'check roadmap.yaml syntax' },
    }];
  }
  if (!doc || !Array.isArray(doc.milestones)) return [];

  const issues = [];
  const milestonesRoot = path.join(stateDir, 'milestones');
  for (const m of doc.milestones) {
    if (!m || m.id === 'backlog') continue;
    const id = typeof m.id === 'string' ? m.id : null;
    if (!id || !/^M\d{3,}$/.test(id)) continue;
    const mDir = path.join(milestonesRoot, id);
    if (!fs.existsSync(mDir)) {
      issues.push({
        id: 'milestone-dir-missing',
        severity: 'warn',
        fixable: 'run-workflow',
        details: { milestone: id, expected: mDir, hint: 'run `/np:plan-phase ' + (m.number || '') + '` to scaffold it' },
      });
      continue;
    }
    const slicesDir = path.join(mDir, 'slices');
    if (!Array.isArray(m.slices) || m.slices.length === 0) continue;
    if (!fs.existsSync(slicesDir)) {
      issues.push({
        id: 'milestone-slices-dir-missing',
        severity: 'warn',
        fixable: 'run-workflow',
        details: { milestone: id, expected: slicesDir },
      });
    }
  }

  issues.push(..._milestoneStatusDrift(doc, projectRoot));
  issues.push(..._rollupDrift(doc, projectRoot));

  const phasesDir = path.join(stateDir, 'phases');
  if (fs.existsSync(phasesDir)) {
    issues.push({
      id: 'legacy-phases-dir',
      severity: 'info',
      fixable: 'manual',
      details: {
        path: phasesDir,
        hint: 'legacy v1 layout detected; safe to remove after /np:plan-phase has scaffolded milestones/',
      },
    });
  }
  return issues;
}

const NUBOSLOOP_CRITICS = [
  'np-critic',             // spawnable (sonnet)
  'np-critic-style',       // axis module (Style)
  'np-critic-tests',       // axis module (Tests)
  'np-critic-acceptance',  // axis module (Acceptance)
  'np-critic-economy',     // axis module (Economy)
];

// The runtimes this project actually installed, per .nubos-pilot/config.json —
// the same shape bin/install.js writes (`runtimes: []`, legacy scalar `runtime`).
// Fail-closed: an absent/unreadable/empty runtime list yields [], which makes the
// agent checks a silent no-op. Reporting nothing is correct here — a missing
// config is already surfaced by the manifest and config checks, and guessing a
// runtime is exactly what produced an unfixable finding before.
function _installedRuntimeIds(projectRoot) {
  const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
  let cfg;
  try {
    cfg = readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return [];
    if (err && _CONFIG_PARSE_CODES.has(err.code)) return [];
    throw err;
  }
  if (cfg && Array.isArray(cfg.runtimes) && cfg.runtimes.length) {
    return cfg.runtimes.filter((id) => typeof id === 'string' && id);
  }
  if (cfg && typeof cfg.runtime === 'string' && cfg.runtime) return [cfg.runtime];
  return [];
}

// Resolve the agents dir per installed runtime, the same way the installer
// writes it (lib/install/runtime-assets.cjs: runtimeConfigDir + meta.agentsSubdir).
//
// Two bugs lived here. The check first looked under `<payload>/agents`
// (.claude/nubos-pilot/agents) while the installer writes `.claude/agents`.
// Correcting the path fixed only Claude: the lookup still hardcoded
// getRuntimeMeta('claude'), so a healthy codex/gemini/opencode-only install kept
// getting `nubosloop-agents-dir-missing` for a directory its runtimes never use,
// with a `update` hint that provably could not create it. Only runtimes that
// declare `agentsSubdir` ship agents at all — for the rest there is nothing to
// check, and silence is the correct answer.
// The extension since: an agents directory no longer implies Markdown. Codex
// reads subagent definitions as `.codex/agents/<name>.toml`, so assuming
// `<dir>/<name>.md` would report every role missing on a healthy install — the
// mirror image of the bug above. Hence `fileFor`: the caller asks the layout
// where a role lives instead of hardcoding one runtime's answer.
function _nubosloopAgentsDirs(projectRoot, scope) {
  const registry = require('../../lib/install/runtimes-registry.cjs');
  const dirs = [];
  for (const id of _installedRuntimeIds(projectRoot)) {
    const meta = registry.getRuntimeMeta(id);
    if (!meta || !meta.agentsSubdir) continue;
    const dir = path.join(registry.runtimeConfigDir(meta, scope, projectRoot), meta.agentsSubdir);
    const ext = meta.agentFormat === 'codex-toml' ? '.toml' : '.md';
    dirs.push({ runtime: id, dir, fileFor: (agent) => path.join(dir, agent + ext) });
  }
  return dirs;
}

// The command surface, same idea. A Codex user's complaint in #3 was precisely
// that nothing told them the workflows were absent, so an install that ships no
// invocable workflow must be a finding rather than a quiet gap.
function _workflowCommandDirs(projectRoot, scope) {
  const registry = require('../../lib/install/runtimes-registry.cjs');
  const dirs = [];
  for (const id of _installedRuntimeIds(projectRoot)) {
    const meta = registry.getRuntimeMeta(id);
    if (!meta) continue;
    if (meta.commandsSubdir) {
      const dir = path.join(registry.runtimeConfigDir(meta, scope, projectRoot), meta.commandsSubdir);
      dirs.push({ runtime: id, dir, fileFor: (wf) => path.join(dir, wf + '.md'), invocation: '/np:<name>' });
      continue;
    }
    if (meta.deliverAsSkills && meta.deliverAsSkills.commands && meta.skillsSubdir) {
      const prefix = meta.deliverAsSkills.prefix || '';
      const dir = path.join(registry.runtimeConfigDir(meta, scope, projectRoot), meta.skillsSubdir);
      dirs.push({
        runtime: id,
        dir,
        fileFor: (wf) => path.join(dir, prefix + wf, 'SKILL.md'),
        invocation: '$' + prefix + '<name>',
      });
    }
  }
  return dirs;
}

// Not the full 36 — a spot check of the loop's spine. If these four are there the
// install wrote its command surface; if they are not, it did not.
const CORE_WORKFLOWS = ['new-project', 'plan-phase', 'execute-phase', 'verify-work'];

function _checkWorkflowCommandSurface(projectRoot) {
  const issues = [];
  const scope = _readScope(projectRoot);
  for (const { runtime, dir, fileFor, invocation } of _workflowCommandDirs(projectRoot, scope)) {
    const missing = CORE_WORKFLOWS.filter((wf) => !fs.existsSync(fileFor(wf)));
    if (missing.length === 0) continue;
    issues.push({
      id: missing.length === CORE_WORKFLOWS.length
        ? 'workflow-commands-dir-missing'
        : 'workflow-command-missing',
      severity: 'warn',
      fixable: 'reinstall',
      details: {
        runtime,
        expected: dir,
        missing,
        invocation,
        hint: 'run `npx nubos-pilot update` to refresh the payload; the workflows are'
          + ' invoked as `' + invocation + '` in this runtime.',
      },
    });
  }
  return issues;
}

function _checkNubosloopCritics(projectRoot) {
  const issues = [];
  const scope = _readScope(projectRoot);
  for (const { runtime, dir: agentsDir, fileFor } of _nubosloopAgentsDirs(projectRoot, scope)) {
    if (!fs.existsSync(agentsDir)) {
      issues.push({
        id: 'nubosloop-agents-dir-missing',
        severity: 'warn',
        fixable: 'reinstall',
        details: {
          runtime,
          expected: agentsDir,
          hint: 'run `npx nubos-pilot update` to refresh the payload (Critic-Schwarm agents ship as part of the payload).',
        },
      });
      continue;
    }
    for (const agent of NUBOSLOOP_CRITICS) {
      const agentPath = fileFor(agent);
      if (!fs.existsSync(agentPath)) {
        issues.push({
          id: 'nubosloop-critic-missing',
          severity: 'warn',
          fixable: 'reinstall',
          details: {
            runtime,
            agent,
            expected: agentPath,
            hint: 'run `npx nubos-pilot update` to refresh the payload.',
          },
        });
      }
    }
  }
  return issues;
}

function _checkNubosloopKnowledgeStore(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) return issues;
  const learningsPath = path.join(stateDir, 'knowledge', 'learnings.json');
  if (!fs.existsSync(learningsPath)) {
    issues.push({
      id: 'nubosloop-knowledge-store-missing',
      severity: 'info',
      fixable: 'auto',
      details: {
        expected: learningsPath,
        hint: 'auto-created on first Nubosloop commit; safe to ignore on a fresh project.',
      },
    });
    return issues;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'));
    const { STORE_VERSION } = require('../../lib/learnings.cjs');
    const { validate } = require('../../lib/validate.cjs');
    const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    let errors;
    if (isObject && parsed.version === STORE_VERSION) {
      errors = validate(parsed, 'learnings.v1');
    } else if (!isObject || !Array.isArray(parsed.learnings)) {
      errors = [{ message: 'expected JSON object with `version` and `learnings[]`' }];
    } else {
      errors = [];
    }
    if (errors.length) {
      issues.push({
        id: 'nubosloop-knowledge-store-corrupt',
        severity: 'warn',
        fixable: 'manual',
        details: {
          path: learningsPath,
          violations: errors.length,
          first: errors[0].message,
          hint: 'store violates the learnings.v1 schema; remove or restore from a backup.',
        },
      });
    }
  } catch (err) {
    issues.push({
      id: 'nubosloop-knowledge-store-corrupt',
      severity: 'warn',
      fixable: 'manual',
      details: { path: learningsPath, cause: err && err.message },
    });
  }
  return issues;
}

function _checkNubosloopConfig(projectRoot) {
  const issues = [];
  const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
  let cfg;
  try {
    cfg = readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return issues;
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      issues.push({
        id: 'config-json-corrupt',
        severity: 'error',
        fixable: 'manual',
        details: {
          code: err.code,
          message: err.message,
          file: err.details && err.details.file,
          hint: 'Repair or delete .nubos-pilot/config.json — the file is unparseable or has the wrong shape.',
        },
      });
      return issues;
    }
    throw err;
  }
  const swarm = cfg && cfg.swarm;
  const adapter = swarm && swarm.knowledge_adapter;
  if (adapter && adapter !== 'local') {
    issues.push({
      id: 'nubosloop-knowledge-adapter-invalid',
      severity: 'warn',
      fixable: 'manual',
      details: {
        value: adapter,
        supported: ['local'],
        hint: 'set swarm.knowledge_adapter to "local" — falls back to "local" silently otherwise.',
      },
    });
  }
  const loop = cfg && cfg.loop;
  if (loop && loop.maxRounds != null) {
    const n = Number(loop.maxRounds);
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      issues.push({
        id: 'nubosloop-maxRounds-out-of-range',
        severity: 'warn',
        fixable: 'manual',
        details: { value: loop.maxRounds, expected_range: '[1, 10]' },
      });
    }
  }
  return issues;
}

const ORPHAN_TMP_MAX_AGE_MS = 60 * 60 * 1000;

// List tmp-shaped files older than the threshold WITHOUT deleting any. The
// filename grammar for a tmp file lives in lib/core.cjs and is not exported, so
// re-deriving it here would silently drift the moment core changes it. Instead we
// call core's own matcher with an age threshold nothing can exceed: every
// candidate lands in `skipped` (untouched, never unlinked) and doctor applies the
// real age filter itself. Detection reuses the one true matcher; deletion stays
// exclusively in the --fix path below.
function _staleTmpCandidates(dir) {
  const { sweepStaleTmpFiles } = require('../../lib/core.cjs');
  let result;
  try { result = sweepStaleTmpFiles(dir, { olderThanMs: Number.MAX_SAFE_INTEGER }); }
  catch { return []; }
  const candidates = (result && Array.isArray(result.skipped)) ? result.skipped : [];
  const now = Date.now();
  return candidates.filter((abs) => {
    try { return now - fs.statSync(abs).mtimeMs >= ORPHAN_TMP_MAX_AGE_MS; }
    catch { return false; }
  });
}

// `doctor` is a diagnostic: the default run reports, `--fix` repairs. This check
// used to sweep unconditionally, so a bare `doctor` deleted files while claiming
// to be read-only (INST-05/D-15) — and `--fix` then reported the already-done
// sweep as `skipped: no-auto-handler`, which was simply untrue. The check still
// runs in both modes (DoD Rule 1); only the deletion is gated.
function _checkOrphanTmpFiles(projectRoot, opts) {
  const sweep = !!(opts && opts.sweep);
  const issues = [];
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  const dirs = [
    stateDir,
    path.join(stateDir, 'checkpoints'),
    path.join(stateDir, 'knowledge'),
    path.join(stateDir, 'state'),
  ];
  for (const d of dirs) {
    const stale = _staleTmpCandidates(d);
    if (stale.length === 0) continue;
    if (!sweep) {
      issues.push({
        id: 'orphan-tmp-files',
        severity: 'info',
        fixable: 'auto',
        details: {
          dir: d,
          found: stale.length,
          hint: 'Orphaned tmp files (>1h old) from a hard-killed process. Run `doctor --fix` to sweep them.',
        },
      });
      continue;
    }
    const cleaned = [];
    for (const abs of stale) {
      try { fs.unlinkSync(abs); cleaned.push(abs); }
      catch { /* ignore — peer may have just won the unlink race */ }
    }
    if (cleaned.length === 0) continue;
    issues.push({
      id: 'orphan-tmp-files-cleaned',
      severity: 'info',
      fixable: 'auto',
      details: {
        dir: d,
        cleaned: cleaned.length,
        hint: 'Orphaned tmp files (>1h old) from a hard-killed process were swept.',
      },
    });
  }
  return issues;
}

function _checkOrphanCheckpoints(projectRoot) {
  const issues = [];
  const stateDir = path.join(projectRoot, STATE_SUBPATH);
  const cpDir = path.join(stateDir, 'checkpoints');
  if (!fs.existsSync(cpDir)) return issues;
  let entries;
  try { entries = fs.readdirSync(cpDir); } catch { return issues; }

  let currentTask = null;
  try {
    const statePath = path.join(stateDir, 'STATE.md');
    if (fs.existsSync(statePath)) {
      const { readState } = require('../../lib/state.cjs');
      const s = readState(projectRoot);
      currentTask = (s && s.frontmatter && s.frontmatter.current_task) || null;
    }
  } catch { /* state unreadable — treat as null current_task */ }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const taskId = name.slice(0, -5);
    const cpPath = path.join(cpDir, name);
    let cp;
    try { cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8')); }
    catch { continue; }
    if (!cp || cp.status !== 'in-progress') continue;
    if (currentTask === taskId) continue;

    let committedSha = null;
    try { committedSha = require('../../lib/checkpoint-reconcile.cjs').committedSha(taskId, projectRoot); }
    catch { committedSha = null; }

    if (committedSha) {
      issues.push({
        id: 'orphan-checkpoint',
        severity: 'info',
        fixable: 'auto',
        details: {
          task_id: taskId,
          checkpoint: path.relative(projectRoot, cpPath),
          current_task: currentTask,
          committed_sha: committedSha,
          hint: 'Task is already committed (' + committedSha.slice(0, 8) + ') but its checkpoint was never unlinked. '
            + 'A stale tombstone, not in-flight work. `np-tools resume-work` reconciles it against git and prunes it automatically.',
        },
      });
      continue;
    }

    issues.push({
      id: 'orphan-checkpoint',
      severity: 'warn',
      fixable: 'manual',
      details: {
        task_id: taskId,
        checkpoint: path.relative(projectRoot, cpPath),
        current_task: currentTask,
        hint: 'Checkpoint marks task as in-progress, no matching commit exists, and STATE.md.current_task does not match. '
          + 'Likely a genuine crash mid-flight. '
          + 'Run `np-tools undo-task ' + taskId + '` to clean up, or resume the task, after verifying its state.',
      },
    });
  }
  return issues;
}

function _checkOutputSchemas(projectRoot) {
  const issues = [];
  const milestonesRoot = path.join(projectRoot, STATE_SUBPATH, 'milestones');
  if (!fs.existsSync(milestonesRoot)) return issues;
  let entries;
  try { entries = fs.readdirSync(milestonesRoot, { withFileTypes: true }); }
  catch { return issues; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!/^M\d{3,}$/.test(ent.name)) continue;
    const mDir = path.join(milestonesRoot, ent.name);
    for (const suffix of ['-VERIFICATION.md', '-VALIDATION.md']) {
      const file = path.join(mDir, ent.name + suffix);
      if (!fs.existsSync(file)) continue;
      const schemaName = inferSchemaForFile(file);
      if (!schemaName) continue;
      let result;
      try {
        result = outputLint.lintFile(file, getSchema(schemaName));
      } catch (err) {
        issues.push({
          id: 'output-schema-lint-failed',
          severity: 'error',
          fixable: 'manual',
          details: { file, schema: schemaName, cause: err && err.message },
        });
        continue;
      }
      if (!result.ok) {
        issues.push({
          id: 'output-schema-violation',
          severity: 'error',
          fixable: 'manual',
          details: {
            file,
            schema: schemaName,
            violation_count: result.violations.length,
            violations: result.violations.slice(0, 10),
          },
        });
      }
    }
  }
  return issues;
}

function _checkMilestoneRequirements(projectRoot) {
  const issues = [];
  const requirements = require('../../lib/requirements.cjs');
  const { parseRoadmap } = require('../../lib/roadmap.cjs');

  let doc;
  try { doc = parseRoadmap(projectRoot).doc; }
  catch { return issues; }
  if (!doc || !Array.isArray(doc.milestones)) return issues;

  const store = requirements.readRequirements(projectRoot);
  if (!store.present) return issues;

  for (const milestone of doc.milestones) {
    if (!milestone || milestone.id === 'backlog') continue;
    if (milestone.status === 'done' || milestone.status === 'archived') continue;
    const declared = Array.isArray(milestone.requirements) ? milestone.requirements : [];

    if (!declared.length) {
      issues.push({
        id: 'milestone-without-requirements',
        severity: 'warn',
        fixable: false,
        details: {
          milestone: milestone.id,
          reason: 'roadmap.yaml declares no requirement ids for this milestone, so '
            + '/np:validate-phase would audit zero requirements',
          hint: 'Add ids with: np-tools update-phase-meta ' + String(milestone.number || milestone.id)
            + ' --stdin  <<< \'{"requirements":["REQ-01"]}\'',
          known_ids: [...store.byId.keys()].slice(0, 20),
        },
      });
      continue;
    }

    const check = requirements.validateIds(declared, projectRoot);
    if (check.unknown.length || check.malformed.length || check.placeholders.length) {
      issues.push({
        id: 'milestone-requirements-unresolved',
        severity: 'warn',
        fixable: false,
        details: {
          milestone: milestone.id,
          unknown: check.unknown,
          malformed: check.malformed,
          placeholders: check.placeholders,
          reason: 'these ids are declared on the milestone but do not resolve in REQUIREMENTS.md',
        },
      });
    }
  }

  const unassigned = requirements.unassignedIds(projectRoot, doc);
  if (unassigned.length) {
    issues.push({
      id: 'requirements-unassigned',
      severity: 'info',
      fixable: false,
      details: {
        count: unassigned.length,
        ids: unassigned.slice(0, 20),
        reason: 'these requirements are declared in REQUIREMENTS.md but no milestone claims them',
      },
    });
  }

  return issues;
}

const ADVISORY_STALE_DAYS = 90;

function _checkAdvisoryDb(opts) {
  const o = opts || {};
  const db = require('../../lib/scan/advisory/db.cjs');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const snapshot = db.status({
    dir: o.dir || undefined,
    homedir: o.homedir || undefined,
    version: _pkgVersion(),
    now,
  });

  if (snapshot.error) {
    return [{
      id: 'advisory-db-unreadable',
      severity: 'warn',
      fixable: 'reinstall',
      details: {
        dir: snapshot.dir,
        cause: snapshot.error,
        hint: 'the advisory manifest is unparseable or declares an unsupported schema_version. '
          + 'Re-run `npx nubos-pilot update` to replace the snapshot, or delete '
          + snapshot.dir + ' — the scanner then reports an honest coverage gap.',
      },
    }];
  }

  if (!snapshot.present) {
    return [{
      id: 'advisory-db-missing',
      severity: 'info',
      fixable: 'reinstall',
      details: {
        expected: db.homeDbDir({ homedir: o.homedir || undefined, version: _pkgVersion() }),
        hint: 'no advisory snapshot is installed, so the dependency scanner reports every '
          + 'package as unchecked instead of clean. A release build ships one; '
          + '`npx nubos-pilot update` copies it into the shared per-user cache.',
      },
    }];
  }

  const issues = [];
  const integrity = snapshot.integrity;
  if (integrity && integrity.mismatches.length > 0) {
    issues.push({
      id: 'advisory-db-tampered',
      severity: 'error',
      fixable: 'reinstall',
      details: {
        dir: snapshot.dir,
        shards: integrity.mismatches,
        hint: 'these shards do not match the SHA-256 recorded in manifest.json. A modified '
          + 'store produces silently false negatives — delete ' + snapshot.dir
          + ' and re-run `npx nubos-pilot update`.',
      },
    });
  }
  if (integrity && integrity.missing.length > 0) {
    issues.push({
      id: 'advisory-db-incomplete',
      severity: 'warn',
      fixable: 'reinstall',
      details: {
        dir: snapshot.dir,
        shards: integrity.missing,
        hint: 'the manifest lists these shards but they are not on disk, so their ecosystems '
          + 'are unchecked. Re-run `npx nubos-pilot update` to restore them.',
      },
    });
  }
  if (Number.isInteger(snapshot.age_days) && snapshot.age_days > ADVISORY_STALE_DAYS) {
    issues.push({
      id: 'advisory-db-stale',
      severity: 'info',
      fixable: 'reinstall',
      details: {
        dir: snapshot.dir,
        age_days: snapshot.age_days,
        generated_at: snapshot.generated_at,
        stale_after_days: ADVISORY_STALE_DAYS,
        hint: 'advisories published after ' + snapshot.generated_at + ' are not in this '
          + 'snapshot. Install a newer nubos-pilot release to refresh it.',
      },
    });
  }
  return issues;
}

function _audit(projectRoot, opts) {
  const sweep = !!(opts && opts.sweep);
  const scope = _readScope(projectRoot);
  const payloadDir = _payloadDirFor(projectRoot, scope);
  const issues = [];
  const { manifest, issues: manifestIssues } = _checkManifestIntegrity(projectRoot, scope);
  issues.push(...manifestIssues);
  issues.push(..._checkVersionMismatch(manifest));
  issues.push(..._checkHooksMissing(manifest, payloadDir));
  const codex = _checkCodexTrappedFeatures();
  issues.push(...codex.issues);
  issues.push(..._checkAskUserBroken());
  issues.push(..._checkCodebaseDocs(projectRoot));
  issues.push(..._checkMilestoneLayout(projectRoot));
  issues.push(..._checkMilestoneRequirements(projectRoot));
  issues.push(..._checkNubosloopCritics(projectRoot));
  issues.push(..._checkWorkflowCommandSurface(projectRoot));
  issues.push(..._checkNubosloopKnowledgeStore(projectRoot));
  issues.push(..._checkNubosloopConfig(projectRoot));
  issues.push(..._checkOrphanTmpFiles(projectRoot, { sweep }));
  issues.push(..._checkOrphanCheckpoints(projectRoot));
  issues.push(..._checkOutputSchemas(projectRoot));
  issues.push(..._checkAdvisoryDb({ ...(opts && opts.advisoryDb), now: opts && opts.now }));
  return { issues, _codexContent: codex.content };
}

function _fixCodexTrappedFeatures(content) {
  const repaired = codexTomlMod.repairTrappedFeatures(content);
  if (repaired === content) return false;
  atomicWriteFileSync(CODEX_CONFIG_PATH, repaired);
  return true;
}

// Repair handlers for `fixable: 'prompt'` issues, keyed by issue id. Empty today:
// the only prompt-fixable issue is `askuser-broken`, which is an environment
// fault doctor cannot repair. An id absent here is reported as skipped, never
// as applied.
//
// `Object.create(null)` — not `{}` — because the lookup below is keyed by issue
// id, and a plain object inherits from Object.prototype: `constructor`,
// `toString` and `valueOf` all resolve to truthy functions. With `Object.freeze({})`
// this guarantee was false — an issue with id `constructor` reached askUser(),
// called Object() as its "handler", and was reported applied as
// `constructor-repaired`, the exact phantom-repair this registry exists to
// prevent. A null prototype plus the Object.hasOwn() gate below makes the
// sentence above true rather than merely true-by-luck.
const PROMPT_FIX_HANDLERS = Object.freeze(Object.create(null));

async function _applyFixes(issues, codexContent, askUser, stderr) {
  const applied = [];
  const skipped = [];
  for (const issue of issues) {
    if (issue.fixable === 'auto') {
      // The sweep already ran inside _audit({sweep:true}) — this issue IS the
      // record of the repair, so report it applied. Reporting it `skipped:
      // no-auto-handler`, as the generic branch below did, contradicted the
      // deletion that had just happened.
      if (issue.id === 'orphan-tmp-files-cleaned') {
        applied.push({ id: issue.id, fix: 'orphan-tmp-files-swept' });
        continue;
      }
      if (issue.id === 'codex-trapped-features' && codexContent != null) {
        try {
          const ok = _fixCodexTrappedFeatures(codexContent);
          if (ok) applied.push({ id: issue.id, fix: 'codex-trapped-features-repaired' });
          else skipped.push({ id: issue.id, reason: 'no-change' });
        } catch (err) {
          skipped.push({ id: issue.id, reason: 'fix-failed', cause: err && err.message });
        }
      } else {
        skipped.push({ id: issue.id, reason: 'no-auto-handler' });
      }
      continue;
    }
    if (issue.fixable === 'prompt') {
      // This branch used to ask "repair?" and, on yes, push `applied` — with no
      // repair code anywhere between the question and the claim. Only prompt when
      // a real handler exists; otherwise say plainly that nothing was repaired.
      const handler = Object.hasOwn(PROMPT_FIX_HANDLERS, issue.id)
        ? PROMPT_FIX_HANDLERS[issue.id]
        : null;
      if (typeof handler !== 'function') {
        skipped.push({ id: issue.id, reason: 'no-repair-implemented' });
        continue;
      }
      const answer = await askUser({
        type: 'confirm',
        question: `Issue ${issue.id} gefunden — reparieren?`,
        default: true,
      });
      if (!answer || !answer.value) {
        skipped.push({ id: issue.id, reason: 'user-declined' });
        continue;
      }
      try {
        const ok = await handler(issue);
        if (ok) applied.push({ id: issue.id, fix: issue.id + '-repaired' });
        else skipped.push({ id: issue.id, reason: 'no-change' });
      } catch (err) {
        skipped.push({ id: issue.id, reason: 'fix-failed', cause: err && err.message });
      }
      continue;
    }
    if (issue.fixable === 'reinstall') {
      try { stderr.write(`[doctor] ${issue.id}: Run \`npx nubos-pilot\` to reinstall.\n`); } catch {}
      skipped.push({ id: issue.id, reason: 'requires-reinstall' });
      continue;
    }
    if (issue.fixable === 'run-workflow') {
      const hint = (issue.details && issue.details.hint) || 'run the suggested np workflow';
      try { stderr.write(`[doctor] ${issue.id}: ${hint}.\n`); } catch {}
      skipped.push({ id: issue.id, reason: 'requires-workflow' });
      continue;
    }
    skipped.push({ id: issue.id, reason: 'not-fixable' });
  }
  return { applied, skipped };
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const askUser = typeof context.askUser === 'function'
    ? context.askUser
    : askuserMod.askUser;
  const list = Array.isArray(args) ? args : [];
  const doFix = list.includes('--fix');

  const audit = _audit(cwd, {
    sweep: doFix,
    now: context.now,
    advisoryDb: context.advisoryDb,
  });
  const payload = { issues: audit.issues };

  if (doFix && audit.issues.length > 0) {
    const { applied, skipped } = await _applyFixes(
      audit.issues,
      audit._codexContent,
      askUser,
      stderr,
    );
    payload.applied = applied;
    payload.skipped = skipped;
  }

  // A diagnostic that always exits 0 cannot be scripted against. run() used to
  // return the payload object, and np-tools.cjs only exits non-zero for a
  // returned NUMBER — so the exit code was always 0, even with severity:'error'.
  // Return the code, like askuser.cjs and plan-lint.cjs do; the payload still
  // goes to stdout as JSON. Only `error` is fatal — `warn` stays exit 0 so an
  // advisory finding does not break callers.
  payload.ok = !audit.issues.some((i) => i && i.severity === 'error');

  try { stdout.write(JSON.stringify(payload)); } catch (err) {
    throw new NubosPilotError('doctor-emit-failed', err && err.message, {});
  }
  return payload.ok ? 0 : 1;
}

// _applyFixes / _audit / PROMPT_FIX_HANDLERS are exported for tests: the repair
// dispatch cannot be reached through run() with an arbitrary issue id (no check
// emits one), and a test that only greps this file for a symbol proves nothing
// about its behaviour.
module.exports = { run, _audit, _applyFixes, PROMPT_FIX_HANDLERS };

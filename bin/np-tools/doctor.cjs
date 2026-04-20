'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const manifestMod = require('../../lib/install/manifest.cjs');
const codexTomlMod = require('../../lib/install/codex-toml.cjs');
const askuserMod = require('../../lib/askuser.cjs');
const codebaseManifest = require('../../lib/codebase-manifest.cjs');
const { scan: workspaceScan } = require('../../lib/workspace-scan.cjs');

const PAYLOAD_SUBPATH = path.join('.claude', 'nubos-pilot');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

function _payloadDirFor(projectRoot) {
  return path.join(projectRoot, PAYLOAD_SUBPATH);
}

function _pkgVersion() {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function _checkManifestIntegrity(payloadDir) {
  const issues = [];
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
    const full = path.join(payloadDir, rel);
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

function _checkMilestoneLayout(projectRoot) {
  const stateDir = path.join(projectRoot, '.nubos-pilot');
  const roadmapPath = path.join(stateDir, 'roadmap.yaml');
  if (!fs.existsSync(roadmapPath)) return [];
  let doc;
  try {
    const YAML = require('yaml');
    doc = YAML.parse(fs.readFileSync(roadmapPath, 'utf-8'));
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

  // Flag old .nubos-pilot/phases/ dir as stale if still present
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

function _audit(projectRoot) {
  const payloadDir = _payloadDirFor(projectRoot);
  const issues = [];
  const { manifest, issues: manifestIssues } = _checkManifestIntegrity(payloadDir);
  issues.push(...manifestIssues);
  issues.push(..._checkVersionMismatch(manifest));
  issues.push(..._checkHooksMissing(manifest, payloadDir));
  const codex = _checkCodexTrappedFeatures();
  issues.push(...codex.issues);
  issues.push(..._checkAskUserBroken());
  issues.push(..._checkCodebaseDocs(projectRoot));
  issues.push(..._checkMilestoneLayout(projectRoot));
  return { issues, _codexContent: codex.content };
}

function _fixCodexTrappedFeatures(content) {
  const repaired = codexTomlMod.repairTrappedFeatures(content);
  if (repaired === content) return false;
  atomicWriteFileSync(CODEX_CONFIG_PATH, repaired);
  return true;
}

async function _applyFixes(issues, codexContent, askUser, stderr) {
  const applied = [];
  const skipped = [];
  for (const issue of issues) {
    if (issue.fixable === 'auto') {
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
      const answer = await askUser({
        type: 'confirm',
        question: `Issue ${issue.id} gefunden — reparieren?`,
        default: true,
      });
      if (answer && answer.value) {
        applied.push({ id: issue.id, fix: 'user-confirmed' });
      } else {
        skipped.push({ id: issue.id, reason: 'user-declined' });
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

  const audit = _audit(cwd);
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

  try { stdout.write(JSON.stringify(payload)); } catch (err) {
    throw new NubosPilotError('doctor-emit-failed', err && err.message, {});
  }
  return payload;
}

module.exports = { run };

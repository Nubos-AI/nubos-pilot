'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const manifestMod = require('../../lib/install/manifest.cjs');
const codexTomlMod = require('../../lib/install/codex-toml.cjs');
const askuserMod = require('../../lib/askuser.cjs');

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

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFileSync, withFileLock, NubosPilotError } = require('../lib/core.cjs');
const { askUser: defaultAskUser } = require('../lib/askuser.cjs');
const manifestMod = require('../lib/install/manifest.cjs');
const stagingMod = require('../lib/install/staging.cjs');
const managedBlockMod = require('../lib/install/managed-block.cjs');
const agentsMdMod = require('../lib/install/agents-md.cjs');
const codexTomlMod = require('../lib/install/codex-toml.cjs');
const runtimeDetectMod = require('../lib/install/runtime-detect.cjs');
const backupMod = require('../lib/install/backup.cjs');

const cyan = '\x1b[36m', green = '\x1b[32m', yellow = '\x1b[33m',
      red = '\x1b[31m', dim = '\x1b[2m', reset = '\x1b[0m';

const PAYLOAD_SUBPATH = path.join('.claude', 'nubos-pilot');
const STATE_SUBPATH = '.nubos-pilot';
const SOURCE_PAYLOAD_DIR = path.join(__dirname, '..', 'templates', 'claude', 'payload');
const OPENCODE_SUBPATH = path.join('.opencode', 'nubos-pilot');
const OPENCODE_MANIFEST_PREFIX = '.opencode/nubos-pilot/';
const SOURCE_OPENCODE_DIR = path.join(__dirname, '..', 'templates', 'opencode', 'payload');
const OPENCODE_JSON_TEMPLATE = path.join(__dirname, '..', 'templates', 'opencode', 'opencode.json');

const MANAGED_BLOCK_INNER =
  'This project uses [nubos-pilot](https://github.com/nubos/nubos-pilot)'
  + ' for planning and execution.\n\nRun `npx nubos-pilot doctor`'
  + ' to check install integrity.';

function _payloadDirFor(projectRoot) {
  return path.join(projectRoot, PAYLOAD_SUBPATH);
}

function _stateDirFor(projectRoot) {
  return path.join(projectRoot, STATE_SUBPATH);
}

function detectMode(projectRoot) {
  const payloadDir = _payloadDirFor(projectRoot);
  return manifestMod.readManifest(payloadDir) ? 're-install' : 'init';
}

function _copyTree(src, dst) {
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return; 
    throw err;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      _copyTree(from, to);
    } else if (e.isFile()) {
      fs.copyFileSync(from, to);
    }

  }
}

async function _runInitQuestions(detectedRuntime, askUser) {
  const runtime = (await askUser({ type: 'select', question: 'Welche Runtime nutzt du?',
    options: ['claude', 'codex', 'gemini', 'opencode'], default: detectedRuntime || 'claude' })).value;
  const model_profile = (await askUser({ type: 'select', question: 'Model-Profile?',
    options: ['inherit', 'quality', 'balanced', 'budget'], default: 'inherit' })).value;
  const commit_docs = (await askUser({ type: 'confirm', question: 'Commit documentation artefacts?', default: true })).value;
  const branching_strategy = (await askUser({ type: 'select', question: 'Branching strategy?',
    options: ['single-branch', 'phase-branches', 'milestone-branches'], default: 'single-branch' })).value;
  const phase_branch_template = (await askUser({ type: 'input', question: 'Phase branch template?', default: 'phase/{number}-{slug}' })).value;
  const milestone_branch_template = (await askUser({ type: 'input', question: 'Milestone branch template?', default: 'milestone/{name}' })).value;
  const parallelization = (await askUser({ type: 'confirm', question: 'Enable parallelization?', default: true })).value;
  const research = (await askUser({ type: 'confirm', question: 'Enable research step?', default: false })).value;
  const plan_checker = (await askUser({ type: 'confirm', question: 'Enable plan_checker?', default: true })).value;
  const verifier = (await askUser({ type: 'confirm', question: 'Enable verifier?', default: true })).value;
  const response_language = (await askUser({ type: 'input', question: 'Response language (ISO-639 code)?', default: 'en' })).value;
  return { runtime, model_profile, commit_docs, branching_strategy, phase_branch_template,
    milestone_branch_template, parallelization, research, plan_checker, verifier, response_language };
}

function _repairCodexConfig() {
  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(codexConfig)) return false;
  let raw;
  try { raw = fs.readFileSync(codexConfig, 'utf-8'); } catch { return false; }
  if (!codexTomlMod.hasTrappedFeatures(raw)) return false;
  const repaired = codexTomlMod.repairTrappedFeatures(raw);
  atomicWriteFileSync(codexConfig, repaired);
  console.error(green + '  [codex] trapped [features] repariert' + reset);
  return true;
}

function _rewriteManagedMarkdown(projectRoot) {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const claudeExists = fs.existsSync(claudePath);
  if (claudeExists) {
    const content = fs.readFileSync(claudePath, 'utf-8');
    const next = managedBlockMod.rewriteBlock(content, MANAGED_BLOCK_INNER);
    atomicWriteFileSync(claudePath, next);
  }

  let agentsBase;
  if (fs.existsSync(agentsPath)) {
    agentsBase = fs.readFileSync(agentsPath, 'utf-8');
  } else if (claudeExists) {
    agentsBase = agentsMdMod.generateAgentsMd(fs.readFileSync(claudePath, 'utf-8'), 'codex');
  } else {
    return; 
  }
  const agentsNext = managedBlockMod.rewriteBlock(agentsBase, MANAGED_BLOCK_INNER);
  atomicWriteFileSync(agentsPath, agentsNext);

  let geminiBase;
  if (fs.existsSync(geminiPath)) {
    geminiBase = fs.readFileSync(geminiPath, 'utf-8');
  } else if (claudeExists) {
    geminiBase = agentsMdMod.generateAgentsMd(fs.readFileSync(claudePath, 'utf-8'), 'gemini');
  } else {
    return;
  }
  const geminiNext = managedBlockMod.rewriteBlock(geminiBase, MANAGED_BLOCK_INNER);
  atomicWriteFileSync(geminiPath, geminiNext);
}

async function runInstall(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || o.cwd || process.cwd();
  const mode = o.mode || detectMode(projectRoot);
  const dryRun = !!o.dryRun;
  const askUser = o.askUser || defaultAskUser;
  const sourceDir = o.sourceDir || SOURCE_PAYLOAD_DIR;
  const stateDir = _stateDirFor(projectRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  return withFileLock(path.join(stateDir, '.install.lock'),
    () => _runInstallLocked({ projectRoot, mode, dryRun, askUser, sourceDir, stateDir }),
    { timeoutMs: 60000 });
}

async function _runInstallLocked(ctx) {
  const { projectRoot, mode, dryRun, askUser, sourceDir, stateDir } = ctx;
  console.error(cyan + '→ nubos-pilot install (mode=' + mode + ')' + reset);
  stagingMod.cleanStaleStaging(projectRoot);

  if (mode === 'init') {
    const det = runtimeDetectMod.detectRuntime({ cwd: projectRoot });
    const config = await _runInitQuestions(det && det.runtime, askUser);
    config.runtime = det && det.runtime ? det.runtime : 'codex';
    config.runtime_source = det && det.source ? det.source : 'asked';
    const configPath = path.join(stateDir, 'config.json');
    if (!dryRun) atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
    else console.error(dim + 'DRY-RUN: würde schreiben ' + configPath + reset);
  }

  const payloadDir = _payloadDirFor(projectRoot);
  const oldManifest = manifestMod.readManifest(payloadDir);
  const tmp = stagingMod.stageDir(projectRoot);
  _copyTree(sourceDir, tmp);
  let pkgVersion = '0.0.0';
  try { pkgVersion = String(require('../package.json').version || '0.0.0'); } catch {}
  const newManifest = manifestMod.buildManifest(tmp, pkgVersion);

  const opencodeTarget = path.join(projectRoot, OPENCODE_SUBPATH);
  const opencodeTmp = path.join(stateDir, '.opencode.tmp');
  try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {}
  try {
  let opencodeManifest = null;
  if (fs.existsSync(SOURCE_OPENCODE_DIR)) {
    _copyTree(SOURCE_OPENCODE_DIR, opencodeTmp);
    opencodeManifest = manifestMod.buildManifest(opencodeTmp, pkgVersion);
    for (const rel of Object.keys(opencodeManifest.files)) {
      if (rel.includes('..') || path.isAbsolute(rel)) {
        throw new NubosPilotError('manifest-path-traversal',
          'Opencode payload contains suspicious path', { rel });
      }
      newManifest.files[OPENCODE_MANIFEST_PREFIX + rel] = opencodeManifest.files[rel];
    }
  }
  const diff = manifestMod.diffManifests(oldManifest, newManifest);

  const backupLog = [];
  for (const rel of diff.changed) {
    const existing = path.join(payloadDir, rel);
    if (!fs.existsSync(existing)) continue;
    try {
      const existingHash = manifestMod.fileHashSync(existing);
      const oldHash = (oldManifest && oldManifest.files && oldManifest.files[rel]) || null;
      if (oldHash && existingHash !== oldHash) {
        if (!dryRun) {
          const backedUp = backupMod.backupFile(existing);
          backupLog.push({ rel, backedUp });
          console.error(yellow + '  [conflict] ' + rel + ' → ' + path.basename(backedUp) + reset);
        } else {
          console.error(dim + 'DRY-RUN: würde sichern ' + rel + reset);
        }
      }
    } catch {}
  }

  if (dryRun) {
    const summary = { mode, dryRun: true,
      wouldWrite: Object.keys(newManifest.files).length,
      wouldBackup: backupLog.length, wouldDelete: diff.stale.length,
      wouldWriteGemini: true,
      wouldWriteOpencodeJson: !fs.existsSync(path.join(projectRoot, 'opencode.json')),
      stale: diff.stale, changed: diff.changed, added: diff.added };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    try { stagingMod.cleanStaleStaging(projectRoot); } catch {}
    try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {}
    return summary;
  }

  if (fs.existsSync(payloadDir) && fs.lstatSync(payloadDir).isSymbolicLink()) {
    try { stagingMod.cleanStaleStaging(projectRoot); } catch {}
    throw new NubosPilotError('target-is-symlink',
      'Refusing to swap into a symlink target: ' + payloadDir, { payloadDir });
  }

  stagingMod.finalizeSwap(projectRoot);
  for (const rel of diff.stale) {
    try { fs.unlinkSync(path.join(payloadDir, rel)); } catch {}
  }

  if (opencodeManifest) {
    const opencodeBak = path.join(stateDir, '.opencode.bak');
    try { fs.rmSync(opencodeBak, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(opencodeTarget)) {
      if (fs.lstatSync(opencodeTarget).isSymbolicLink()) {
        throw new NubosPilotError('target-is-symlink',
          'Refusing to swap into a symlink target: ' + opencodeTarget,
          { payloadDir: opencodeTarget });
      }
      fs.renameSync(opencodeTarget, opencodeBak);
    }
    const opencodeParent = path.dirname(opencodeTarget);
    if (fs.existsSync(opencodeParent) && fs.lstatSync(opencodeParent).isSymbolicLink()) {
      throw new NubosPilotError('target-is-symlink',
        'Refusing to install into a symlinked parent: ' + opencodeParent,
        { payloadDir: opencodeParent });
    }
    fs.mkdirSync(opencodeParent, { recursive: true });
    fs.renameSync(opencodeTmp, opencodeTarget);
    try { fs.rmSync(opencodeBak, { recursive: true, force: true }); } catch {}
    for (const rel of diff.stale) {
      if (rel.startsWith(OPENCODE_MANIFEST_PREFIX)) {
        const stalePath = path.join(projectRoot, rel);
        try { fs.unlinkSync(stalePath); } catch {}
      }
    }
  }

  _rewriteManagedMarkdown(projectRoot);

  const projectOpencodeJson = path.join(projectRoot, 'opencode.json');
  if (!fs.existsSync(projectOpencodeJson) && fs.existsSync(OPENCODE_JSON_TEMPLATE)) {
    const template = fs.readFileSync(OPENCODE_JSON_TEMPLATE, 'utf-8');
    atomicWriteFileSync(projectOpencodeJson, template);
  }

  try { _repairCodexConfig(); } catch (err) {
    console.error(yellow + '  [codex] repair skipped: ' + (err && err.message) + reset);
  }
  manifestMod.writeManifest(payloadDir, newManifest);
  console.error(green + '✓ Installation abgeschlossen' + reset);
  return { mode, dryRun: false, written: Object.keys(newManifest.files).length,
    backedUp: backupLog.length, deleted: diff.stale.length };
  } finally {
    try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {}
  }
}

async function runUninstall(opts) {
  const options = opts || {};
  const cwd = options.cwd || process.cwd();
  const projectRoot = options.projectRoot || cwd;
  const stateDir = _stateDirFor(projectRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, '.install.lock');
  return withFileLock(lockPath, () => _runUninstallLocked(projectRoot),
    { timeoutMs: 60000 });
}

function _runUninstallLocked(projectRoot) {
  const payloadDir = _payloadDirFor(projectRoot);
  const manifest = manifestMod.readManifest(payloadDir);
  if (!manifest) {
    console.error(dim + 'Keine Installation gefunden' + reset);
    return { uninstalled: false };
  }

  for (const rel of Object.keys(manifest.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) {
      throw new NubosPilotError(
        'manifest-path-traversal',
        'Manifest contains suspicious path',
        { rel },
      );
    }
  }

  let removed = 0;
  for (const rel of Object.keys(manifest.files)) {
    const abs = path.join(payloadDir, rel);
    try { fs.unlinkSync(abs); removed++; } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error(yellow + '  [uninstall] ' + rel + ' not removed: ' + err.message + reset);
      }
    }
  }

  try { fs.unlinkSync(path.join(payloadDir, '.manifest.json')); } catch {}

  try { fs.rmdirSync(payloadDir); } catch {  }

  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    const stripped = managedBlockMod.stripBlock(fs.readFileSync(p, 'utf-8'));
    if (!stripped || !stripped.trim()) {
      try { fs.unlinkSync(p); } catch {}
    } else {
      atomicWriteFileSync(p, stripped);
    }
  }

  
  const opencodeDir = path.join(projectRoot, OPENCODE_SUBPATH);
  if (fs.existsSync(opencodeDir)) {
    try { fs.rmSync(opencodeDir, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmdirSync(path.join(projectRoot, '.opencode')); } catch {}

  console.error(green + '✓ Uninstall abgeschlossen' + reset);
  let leftovers = [];
  try {
    if (fs.existsSync(payloadDir)) {
      leftovers = fs.readdirSync(payloadDir).filter((f) => /\.bak(\.\d+|\.orphan-)?$/.test(f));
    }
  } catch {}
  if (leftovers.length) {
    console.error(dim + '  User-Backups belassen:' + reset);
    for (const f of leftovers) console.error(dim + '    ' + f + reset);
  }
  return { uninstalled: true, removed, leftoverBaks: leftovers };
}

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0];
  const cwd = process.cwd();
  switch (sub) {
    case undefined:
      return await runInstall({ cwd, mode: detectMode(cwd) });
    case '--dry-run':
      return await runInstall({ cwd, mode: detectMode(cwd), dryRun: true });
    case 'update':
      return await runInstall({ cwd, mode: 'update' });
    case 'uninstall':
      return await runUninstall({ cwd, args: args.slice(1) });
    case 'doctor': {
      const doctor = require('./np-tools/doctor.cjs');
      return await doctor.run(args.slice(1), { cwd, stdout: process.stdout });
    }
    default:
      process.stderr.write(
        red + 'Unbekanntes Subcommand: ' + sub + reset + '\n',
      );
      process.exit(1);
      return undefined;
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err && err.code) {
      process.stderr.write(
        JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
            details: err.details || null,
          },
        }) + '\n',
      );
    } else {
      process.stderr.write(((err && err.stack) || String(err)) + '\n');
    }
    process.exit(1);
  });
}

module.exports = {
  runInstall, runUninstall, detectMode, main,
  SOURCE_PAYLOAD_DIR, PAYLOAD_SUBPATH, STATE_SUBPATH,
  _payloadDirFor, _stateDirFor,
};

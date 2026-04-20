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
const registryMod = require('../lib/install/runtimes-registry.cjs');
const runtimeAssetsMod = require('../lib/install/runtime-assets.cjs');

const cyan = '\x1b[36m', green = '\x1b[32m', yellow = '\x1b[33m',
      red = '\x1b[31m', blue = '\x1b[38;5;33m',
      dim = '\x1b[2m', bold = '\x1b[1m', reset = '\x1b[0m';

const LOGO = [
  ' ███╗   ██╗██╗   ██╗██████╗  ██████╗ ███████╗',
  ' ████╗  ██║██║   ██║██╔══██╗██╔═══██╗██╔════╝',
  ' ██╔██╗ ██║██║   ██║██████╔╝██║   ██║███████╗',
  ' ██║╚██╗██║██║   ██║██╔══██╗██║   ██║╚════██║',
  ' ██║ ╚████║╚██████╔╝██████╔╝╚██████╔╝███████║',
  ' ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝',
];

function _printBanner() {
  let pkgVersion = '0.0.0';
  let pkgDesc = '';
  try {
    const pkg = require('../package.json');
    pkgVersion = String(pkg.version || '0.0.0');
    pkgDesc = String(pkg.description || '');
  } catch {}
  process.stderr.write('\n');
  for (const line of LOGO) process.stderr.write(blue + line + reset + '\n');
  process.stderr.write('\n');
  process.stderr.write(' ' + bold + blue + 'Nubos Pilot' + reset
    + dim + ' v' + pkgVersion + reset + '\n');
  if (pkgDesc) process.stderr.write(' ' + dim + pkgDesc + reset + '\n');
  process.stderr.write('\n');
}

const PAYLOAD_SUBPATH = path.join('.claude', 'nubos-pilot');
const STATE_SUBPATH = '.nubos-pilot';
const SOURCE_PAYLOAD_DIR = path.join(__dirname, '..', 'templates', 'claude', 'payload');
const OPENCODE_SUBPATH = path.join('.opencode', 'nubos-pilot');
const OPENCODE_MANIFEST_PREFIX = '.opencode/nubos-pilot/';
const SOURCE_OPENCODE_DIR = path.join(__dirname, '..', 'templates', 'opencode', 'payload');
const OPENCODE_JSON_TEMPLATE = path.join(__dirname, '..', 'templates', 'opencode', 'opencode.json');
const SOURCE_WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const SOURCE_AGENTS_DIR = path.join(__dirname, '..', 'agents');

function _autoAskUser(spec) {
  return Promise.resolve({
    value: spec && spec.default !== undefined ? spec.default : null,
    source: 'auto',
  });
}

const MANAGED_BLOCK_INNER =
  'This project uses [nubos-pilot](https://github.com/nubos/nubos-pilot)'
  + ' for planning and execution.\n\nRun `npx nubos-pilot doctor`'
  + ' to check install integrity.';

const VALID_AGENTS = registryMod.listRuntimeIds();
const VALID_SCOPES = ['local', 'global'];

function _parseAgentsFlag(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInstallFlags(args) {
  const flags = { agent: null, agents: null, scope: null, mcp: false, yes: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' || a === '-a') { flags.agent = args[++i] || null; continue; }
    if (a.startsWith('--agent=')) { flags.agent = a.slice('--agent='.length); continue; }
    if (a === '--agents') { flags.agents = _parseAgentsFlag(args[++i]); continue; }
    if (a.startsWith('--agents=')) { flags.agents = _parseAgentsFlag(a.slice('--agents='.length)); continue; }
    if (a === '--all') { flags.agents = VALID_AGENTS.slice(); continue; }
    if (a === '--scope' || a === '-s') { flags.scope = args[++i] || null; continue; }
    if (a.startsWith('--scope=')) { flags.scope = a.slice('--scope='.length); continue; }
    if (a === '--mcp') { flags.mcp = true; continue; }
    if (a === '--yes' || a === '-y') { flags.yes = true; continue; }
    rest.push(a);
  }
  if (flags.agent !== null && !VALID_AGENTS.includes(flags.agent)) {
    throw new NubosPilotError('invalid-flag',
      '--agent must be one of: ' + VALID_AGENTS.join(', '),
      { flag: '--agent', got: flags.agent });
  }
  if (flags.agents !== null) {
    for (const a of flags.agents) {
      if (!VALID_AGENTS.includes(a)) {
        throw new NubosPilotError('invalid-flag',
          '--agents values must be one of: ' + VALID_AGENTS.join(', '),
          { flag: '--agents', got: a });
      }
    }
    if (flags.agents.length === 0) {
      throw new NubosPilotError('invalid-flag',
        '--agents requires at least one value',
        { flag: '--agents' });
    }
    if (!flags.agent) flags.agent = flags.agents[0];
  }
  if (flags.scope !== null && !VALID_SCOPES.includes(flags.scope)) {
    throw new NubosPilotError('invalid-flag',
      '--scope must be one of: ' + VALID_SCOPES.join(', '),
      { flag: '--scope', got: flags.scope });
  }
  return { flags, rest };
}

function _payloadDirFor(projectRoot, scope) {
  if (scope === 'global') return path.join(os.homedir(), '.claude', 'nubos-pilot');
  return path.join(projectRoot, PAYLOAD_SUBPATH);
}

function _opencodePayloadDirFor(projectRoot, scope) {
  if (scope === 'global') return path.join(os.homedir(), '.config', 'opencode', 'nubos-pilot');
  return path.join(projectRoot, OPENCODE_SUBPATH);
}

function _opencodeManifestPrefix(scope) {
  return scope === 'global'
    ? '~/.config/opencode/nubos-pilot/'
    : OPENCODE_MANIFEST_PREFIX;
}

function _stateDirFor(projectRoot) {
  return path.join(projectRoot, STATE_SUBPATH);
}

function _readExistingScope(projectRoot) {
  const cfgPath = path.join(_stateDirFor(projectRoot), 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg && cfg.scope ? cfg.scope : null;
  } catch { return null; }
}

function _readExistingRuntimes(projectRoot) {
  const cfgPath = path.join(_stateDirFor(projectRoot), 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (Array.isArray(cfg.runtimes) && cfg.runtimes.length) return cfg.runtimes.slice();
    if (cfg.runtime) return [cfg.runtime];
    return null;
  } catch { return null; }
}

function detectMode(projectRoot, scope) {
  const s = scope || _readExistingScope(projectRoot) || 'local';
  const payloadDir = _payloadDirFor(projectRoot, s);
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

function _runtimeSelectLabels() {
  return registryMod.RUNTIMES.map((r) => {
    const home = registryMod.runtimeGlobalDir(r).replace(process.env.HOME || '', '~');
    return r.label + '  (' + home + ')';
  });
}

async function _runInitQuestions(detectedRuntime, askUser, flags) {
  const f = flags || {};
  let runtimes;
  if (f.agents && f.agents.length) {
    runtimes = f.agents.slice();
  } else if (f.agent) {
    runtimes = [f.agent];
  } else {
    const labels = _runtimeSelectLabels();
    const detectedIdx = Math.max(0, VALID_AGENTS.indexOf(detectedRuntime || 'claude'));
    const picked = (await askUser({ type: 'multiselect',
      question: 'Which runtime(s) would you like to install for?',
      options: labels, default: [labels[detectedIdx]] })).value;
    runtimes = Array.isArray(picked) && picked.length && typeof picked[0] === 'string'
      && picked[0].includes('(')
      ? picked.map((label) => {
          const idx = labels.indexOf(label);
          return VALID_AGENTS[idx];
        })
      : (Array.isArray(picked) ? picked : [picked]);
  }
  const runtime = runtimes[0];
  const scope = f.scope || (await askUser({ type: 'select', question: 'Installation scope?',
    options: VALID_SCOPES, default: 'local' })).value;
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
  return { runtime, runtimes, scope, mcp: !!f.mcp, model_profile, commit_docs, branching_strategy, phase_branch_template,
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

const LEGACY_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode']);

function _rewriteManagedMarkdown(projectRoot, runtimes) {
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
    agentsBase = null;
  }
  if (agentsBase !== null) {
    const agentsNext = managedBlockMod.rewriteBlock(agentsBase, MANAGED_BLOCK_INNER);
    atomicWriteFileSync(agentsPath, agentsNext);
  }

  let geminiBase;
  if (fs.existsSync(geminiPath)) {
    geminiBase = fs.readFileSync(geminiPath, 'utf-8');
  } else if (claudeExists) {
    geminiBase = agentsMdMod.generateAgentsMd(fs.readFileSync(claudePath, 'utf-8'), 'gemini');
  } else {
    geminiBase = null;
  }
  if (geminiBase !== null) {
    const geminiNext = managedBlockMod.rewriteBlock(geminiBase, MANAGED_BLOCK_INNER);
    atomicWriteFileSync(geminiPath, geminiNext);
  }

  const extras = (runtimes || []).filter((id) => !LEGACY_AGENTS.has(id));
  for (const id of extras) {
    const meta = registryMod.getRuntimeMeta(id);
    if (!meta) continue;
    const targetPath = registryMod.runtimeAgentsPath(meta, 'local', projectRoot);
    let base;
    if (fs.existsSync(targetPath)) {
      base = fs.readFileSync(targetPath, 'utf-8');
    } else if (claudeExists) {
      base = agentsMdMod.generateAgentsMd(fs.readFileSync(claudePath, 'utf-8'), 'codex');
    } else {
      base = '';
    }
    const next = managedBlockMod.rewriteBlock(base, MANAGED_BLOCK_INNER);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, next);
  }
}

async function runInstall(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || o.cwd || process.cwd();
  const flags = o.flags || {};
  const mode = o.mode || detectMode(projectRoot, flags.scope);
  const dryRun = !!o.dryRun;
  const askUser = flags.yes ? _autoAskUser : (o.askUser || defaultAskUser);
  const sourceDir = o.sourceDir || SOURCE_PAYLOAD_DIR;
  const stateDir = _stateDirFor(projectRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  return withFileLock(path.join(stateDir, '.install.lock'),
    () => _runInstallLocked({ projectRoot, mode, dryRun, askUser, sourceDir, stateDir, flags }),
    { timeoutMs: 60000 });
}

async function _runInstallLocked(ctx) {
  const { projectRoot, mode, dryRun, askUser, sourceDir, stateDir, flags } = ctx;
  _printBanner();
  console.error(cyan + '→ nubos-pilot install (mode=' + mode + ')' + reset);

  const preliminaryScope = (flags && flags.scope) || _readExistingScope(projectRoot) || 'local';
  const preliminaryBase = preliminaryScope === 'global' ? os.homedir() : projectRoot;
  stagingMod.cleanStaleStaging(preliminaryBase);

  let initConfig = null;
  if (mode === 'init') {
    const det = runtimeDetectMod.detectRuntime({ cwd: projectRoot });
    const config = await _runInitQuestions(det && det.runtime, askUser, flags);
    if (flags && flags.agent) {
      config.runtime = flags.agent;
      config.runtime_source = 'flag';
    } else {
      config.runtime = det && det.runtime ? det.runtime : config.runtime || 'codex';
      config.runtime_source = det && det.source ? det.source : 'asked';
    }
    const configPath = path.join(stateDir, 'config.json');
    if (!dryRun) atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
    else console.error(dim + 'DRY-RUN: würde schreiben ' + configPath + reset);
    initConfig = config;
  }

  const resolvedScope = (initConfig && initConfig.scope) || preliminaryScope;
  const payloadBase = resolvedScope === 'global' ? os.homedir() : projectRoot;
  const payloadDir = _payloadDirFor(projectRoot, resolvedScope);
  const oldManifest = manifestMod.readManifest(payloadDir);
  const tmp = stagingMod.stageDir(payloadBase);
  _copyTree(sourceDir, tmp);
  let pkgVersion = '0.0.0';
  try { pkgVersion = String(require('../package.json').version || '0.0.0'); } catch {}
  const newManifest = manifestMod.buildManifest(tmp, pkgVersion);

  const selectedRuntimesEarly = (initConfig && initConfig.runtimes)
    || (initConfig ? [initConfig.runtime] : null)
    || _readExistingRuntimes(projectRoot)
    || [];
  const opencodeSelected = selectedRuntimesEarly.includes('opencode');

  const assetPlans = runtimeAssetsMod.planRuntimeAssets({
    selectedRuntimes: selectedRuntimesEarly,
    scope: resolvedScope,
    projectRoot,
    workflowsDir: SOURCE_WORKFLOWS_DIR,
    agentsDir: SOURCE_AGENTS_DIR,
  });
  const assetEntries = runtimeAssetsMod.manifestEntriesForPlans(assetPlans);
  for (const k of Object.keys(assetEntries)) {
    newManifest.files[k] = assetEntries[k];
  }

  const opencodeTarget = _opencodePayloadDirFor(projectRoot, resolvedScope);
  const opencodeManifestPrefix = _opencodeManifestPrefix(resolvedScope);
  const opencodeTmp = path.join(stateDir, '.opencode.tmp');
  try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {}
  try {
  let opencodeManifest = null;
  if (opencodeSelected && fs.existsSync(SOURCE_OPENCODE_DIR)) {
    _copyTree(SOURCE_OPENCODE_DIR, opencodeTmp);
    opencodeManifest = manifestMod.buildManifest(opencodeTmp, pkgVersion);
    for (const rel of Object.keys(opencodeManifest.files)) {
      if (rel.includes('..') || path.isAbsolute(rel)) {
        throw new NubosPilotError('manifest-path-traversal',
          'Opencode payload contains suspicious path', { rel });
      }
      newManifest.files[opencodeManifestPrefix + rel] = opencodeManifest.files[rel];
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
      scope: resolvedScope,
      wouldWrite: Object.keys(newManifest.files).length,
      wouldBackup: backupLog.length, wouldDelete: diff.stale.length,
      wouldWriteGemini: true,
      wouldWriteOpencodeJson: opencodeSelected && !fs.existsSync(path.join(projectRoot, 'opencode.json')),
      stale: diff.stale, changed: diff.changed, added: diff.added };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    try { stagingMod.cleanStaleStaging(payloadBase); } catch {}
    try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {}
    return summary;
  }

  if (fs.existsSync(payloadDir) && fs.lstatSync(payloadDir).isSymbolicLink()) {
    try { stagingMod.cleanStaleStaging(payloadBase); } catch {}
    throw new NubosPilotError('target-is-symlink',
      'Refusing to swap into a symlink target: ' + payloadDir, { payloadDir });
  }

  stagingMod.finalizeSwap(payloadBase);
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
    const opencodeBase = resolvedScope === 'global' ? os.homedir() : projectRoot;
    for (const rel of diff.stale) {
      if (rel.startsWith(opencodeManifestPrefix)) {
        const relFs = rel.startsWith('~/')
          ? path.join(os.homedir(), rel.slice(2))
          : path.join(opencodeBase, rel);
        try { fs.unlinkSync(relFs); } catch {}
      }
    }
  } else if (!opencodeSelected && fs.existsSync(opencodeTarget)) {
    try { fs.rmSync(opencodeTarget, { recursive: true, force: true }); } catch {}
    const opencodeParent = path.dirname(opencodeTarget);
    try { fs.rmdirSync(opencodeParent); } catch {}
    const projectOpencodeJson = path.join(projectRoot, 'opencode.json');
    if (fs.existsSync(projectOpencodeJson) && fs.existsSync(OPENCODE_JSON_TEMPLATE)) {
      try {
        const template = fs.readFileSync(OPENCODE_JSON_TEMPLATE, 'utf-8');
        const existing = fs.readFileSync(projectOpencodeJson, 'utf-8');
        if (existing === template) fs.unlinkSync(projectOpencodeJson);
      } catch {}
    }
  }

  const selectedRuntimes = (initConfig && initConfig.runtimes) || (initConfig ? [initConfig.runtime] : []);
  _rewriteManagedMarkdown(projectRoot, selectedRuntimes);

  if (assetPlans.length) {
    runtimeAssetsMod.writeRuntimeAssets(assetPlans);
  }
  const assetStale = diff.stale.filter(runtimeAssetsMod.isAssetManifestKey);
  if (assetStale.length) {
    runtimeAssetsMod.removeStaleAssets(assetStale, resolvedScope, projectRoot);
  }

  if (initConfig && initConfig.mcp && !dryRun) {
    try {
      const mcpWriter = require('../lib/install/mcp-writer.cjs');
      const result = mcpWriter.writeMcpConfig({
        runtime: initConfig.runtime,
        scope: initConfig.scope,
        projectRoot,
      });
      console.error(green + '  [mcp] nubos MCP configured → ' + result.path + reset);
    } catch (err) {
      console.error(yellow + '  [mcp] skipped: ' + (err && err.message) + reset);
    }
  }

  if (opencodeSelected) {
    const projectOpencodeJson = path.join(projectRoot, 'opencode.json');
    if (!fs.existsSync(projectOpencodeJson) && fs.existsSync(OPENCODE_JSON_TEMPLATE)) {
      const template = fs.readFileSync(OPENCODE_JSON_TEMPLATE, 'utf-8');
      atomicWriteFileSync(projectOpencodeJson, template);
    }
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
  const scope = _readExistingScope(projectRoot) || 'local';
  const payloadDir = _payloadDirFor(projectRoot, scope);
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

  const payloadBase = scope === 'global' ? os.homedir() : projectRoot;
  let removed = 0;
  const assetDirs = new Set();
  for (const rel of Object.keys(manifest.files)) {
    const isAsset = runtimeAssetsMod.isAssetManifestKey(rel);
    const abs = isAsset ? path.join(payloadBase, rel) : path.join(payloadDir, rel);
    try {
      fs.unlinkSync(abs);
      removed++;
      if (isAsset) assetDirs.add(path.dirname(abs));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error(yellow + '  [uninstall] ' + rel + ' not removed: ' + err.message + reset);
      }
    }
  }
  const sortedDirs = Array.from(assetDirs).sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    let cur = dir;
    while (cur && cur.startsWith(payloadBase) && cur !== payloadBase) {
      try {
        const entries = fs.readdirSync(cur);
        if (entries.length > 0) break;
        fs.rmdirSync(cur);
      } catch { break; }
      cur = path.dirname(cur);
    }
  }

  try { fs.unlinkSync(path.join(payloadDir, '.manifest.json')); } catch {}

  try { fs.rmdirSync(payloadDir); } catch {  }

  const cfgPath = path.join(_stateDirFor(projectRoot), 'config.json');
  let installedRuntimes = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    installedRuntimes = cfg.runtimes || (cfg.runtime ? [cfg.runtime] : []);
  } catch {}

  const legacyFiles = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
  const extraFiles = [];
  for (const id of installedRuntimes) {
    if (LEGACY_AGENTS.has(id)) continue;
    const meta = registryMod.getRuntimeMeta(id);
    if (!meta) continue;
    extraFiles.push(registryMod.runtimeAgentsPath(meta, 'local', projectRoot));
  }

  const toStrip = legacyFiles
    .map((n) => path.join(projectRoot, n))
    .concat(extraFiles);
  for (const p of toStrip) {
    if (!fs.existsSync(p)) continue;
    const stripped = managedBlockMod.stripBlock(fs.readFileSync(p, 'utf-8'));
    if (!stripped || !stripped.trim()) {
      try { fs.unlinkSync(p); } catch {}
    } else {
      atomicWriteFileSync(p, stripped);
    }
  }

  const opencodeDir = _opencodePayloadDirFor(projectRoot, scope);
  if (fs.existsSync(opencodeDir)) {
    try { fs.rmSync(opencodeDir, { recursive: true, force: true }); } catch {}
  }
  const opencodeParent = path.dirname(opencodeDir);
  try { fs.rmdirSync(opencodeParent); } catch {}

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
  const rawArgs = process.argv.slice(2);
  const { flags, rest } = parseInstallFlags(rawArgs);
  const sub = rest[0];
  const cwd = process.cwd();
  switch (sub) {
    case undefined:
      return await runInstall({ cwd, mode: detectMode(cwd), flags });
    case '--dry-run':
      return await runInstall({ cwd, mode: detectMode(cwd), dryRun: true, flags });
    case 'update':
      return await runInstall({ cwd, mode: 'update', flags });
    case 'uninstall':
      return await runUninstall({ cwd, args: rest.slice(1) });
    case 'doctor': {
      const doctor = require('./np-tools/doctor.cjs');
      return await doctor.run(rest.slice(1), { cwd, stdout: process.stdout });
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
  parseInstallFlags,
  VALID_AGENTS, VALID_SCOPES,
  SOURCE_PAYLOAD_DIR, PAYLOAD_SUBPATH, STATE_SUBPATH,
  _payloadDirFor, _stateDirFor,
};

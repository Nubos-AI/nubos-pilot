#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFileSync, withFileLock, installSignalCleanup, NubosPilotError } = require('../lib/core.cjs');
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
const languageMod = require('../lib/language.cjs');
const configDefaults = require('../lib/config-defaults.cjs');

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
const SOURCE_SKILLS_DIR = path.join(__dirname, '..', 'skills');

function _autoAskUser(spec) {
  return Promise.resolve({
    value: spec && spec.default !== undefined ? spec.default : null,
    source: 'auto',
  });
}

function _managedBlockInner(responseLanguage) {
  return (
    'This project uses [nubos-pilot](https://github.com/nubos/nubos-pilot)'
    + ' for planning and execution.\n\n'
    + languageMod.buildDirective(responseLanguage)
    + '\n\nRun `npx nubos-pilot doctor` to check install integrity.'
  );
}

const VALID_AGENTS = registryMod.listRuntimeIds();
const VALID_SCOPES = ['local', 'global'];

function _parseAgentsFlag(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInstallFlags(args) {
  const flags = { agent: null, agents: null, scope: null, yes: false, dryRun: false };
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
    if (a === '--yes' || a === '-y') { flags.yes = true; continue; }
    // --dry-run is a real flag, not a positional: `update --dry-run` used to land
    // it in rest[1] where nothing read it, silently performing a full install.
    if (a === '--dry-run') { flags.dryRun = true; continue; }
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

// Bins the workflows reference via `node .nubos-pilot/bin/<name>`. Each one
// gets a thin shim in the project's bin dir that re-execs the npm-installed
// target. New bins added at the source side must be added here too — the
// installer doesn't autodiscover.
const PROJECT_BIN_SHIMS = [
  { name: 'np-tools.cjs',          targetRel: '../np-tools.cjs',          mode: 'main' },
  { name: 'researcher-merge.cjs',  targetRel: 'researcher-merge.cjs',     mode: 'spawn' },
];

function _renderShim(target, mode) {
  if (mode === 'main') {
    return '#!/usr/bin/env node\n'
      + "'use strict';\n"
      + 'const fs = require(\'node:fs\');\n'
      + 'if (Number(process.versions.node.split(\'.\')[0]) < 22) {\n'
      + '  process.stderr.write("nubos-pilot: requires Node >= 22 (running " + process.versions.node + ")\\n");\n'
      + '  process.exit(1);\n'
      + '}\n'
      + 'const TARGET = ' + JSON.stringify(target) + ';\n'
      + 'if (!fs.existsSync(TARGET)) {\n'
      + '  process.stderr.write("nubos-pilot: tool binary fehlt unter " + TARGET + "\\nFix: npx nubos-pilot@latest update\\n");\n'
      + '  process.exit(1);\n'
      + '}\n'
      + 'require(TARGET).main();\n';
  }
  return '#!/usr/bin/env node\n'
    + "'use strict';\n"
    + 'const fs = require(\'node:fs\');\n'
    + 'const { spawn } = require(\'node:child_process\');\n'
    + 'if (Number(process.versions.node.split(\'.\')[0]) < 22) {\n'
    + '  process.stderr.write("nubos-pilot: requires Node >= 22 (running " + process.versions.node + ")\\n");\n'
    + '  process.exit(1);\n'
    + '}\n'
    + 'const TARGET = ' + JSON.stringify(target) + ';\n'
    + 'if (!fs.existsSync(TARGET)) {\n'
    + '  process.stderr.write("nubos-pilot: tool binary fehlt unter " + TARGET + "\\nFix: npx nubos-pilot@latest update\\n");\n'
    + '  process.exit(1);\n'
    + '}\n'
    + 'const child = spawn(process.execPath, [TARGET, ...process.argv.slice(2)], { stdio: \'inherit\' });\n'
    + 'child.on(\'error\', (err) => { process.stderr.write("nubos-pilot shim: " + (err && err.message ? err.message : String(err)) + "\\n"); process.exit(1); });\n'
    + 'for (const s of [\'SIGINT\', \'SIGTERM\', \'SIGHUP\']) { process.on(s, () => { try { child.kill(s); } catch {} }); }\n'
    + 'child.on(\'exit\', (code, sig) => { if (sig) process.kill(process.pid, sig); else process.exit(code == null ? 1 : code); });\n';
}

function _writeToolsShim(projectRoot) {
  const shimDir = path.join(projectRoot, STATE_SUBPATH, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  let primary = null;
  for (const spec of PROJECT_BIN_SHIMS) {
    const shimPath = path.join(shimDir, spec.name);
    const target = path.resolve(__dirname, spec.targetRel);
    atomicWriteFileSync(shimPath, _renderShim(target, spec.mode));
    try { fs.chmodSync(shimPath, 0o755); } catch {}
    if (spec.name === 'np-tools.cjs') primary = shimPath;
  }
  return primary;
}

function _stateDirFor(projectRoot) {
  return path.join(projectRoot, STATE_SUBPATH);
}

function _readInstallConfig(projectRoot) {
  const cfgPath = path.join(_stateDirFor(projectRoot), 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  const { _CONFIG_PARSE_CODES, readConfig } = require('../lib/config.cjs');
  const { NubosPilotError } = require('../lib/core.cjs');
  try {
    return readConfig(projectRoot);
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      throw new NubosPilotError(
        'install-config-unusable',
        'install refused — .nubos-pilot/config.json is unusable (' + err.code
          + '). Repair or delete the file and re-run.',
        { cause: err.code },
      );
    }
    throw err;
  }
}

// Shared read for the re-install/update backfills: parse the existing config.json
// once. Returns `{ cfgPath, cfg, status }` where status is 'ok' | 'absent' |
// 'unparseable' and cfg is null unless status is 'ok'.
function _loadConfigJson(stateDir) {
  const cfgPath = path.join(stateDir, 'config.json');
  let raw;
  try { raw = fs.readFileSync(cfgPath, 'utf-8'); } catch { return { cfgPath, cfg: null, status: 'absent' }; }
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return { cfgPath, cfg: null, status: 'unparseable' }; }
  if (!cfg || typeof cfg !== 'object') return { cfgPath, cfg: null, status: 'unparseable' };
  return { cfgPath, cfg, status: 'ok' };
}

// Apply the ultra economy default in-memory (never overwriting an explicit
// economy OR legacy economy_critic choice). Returns 'backfilled' | 'preserved'.
function _applyEconomyDefault(cfg) {
  const agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : null;
  if (agents && (agents.economy !== undefined || agents.economy_critic !== undefined)) {
    return 'preserved';
  }
  cfg.agents = { ...(agents || {}), economy: configDefaults.INSTALL_ECONOMY_MODE };
  return 'backfilled';
}

// Apply the default-on loop-agent toggles (architect, test-writer) in-memory,
// never overwriting an explicit true/false. Returns the keys added.
const _BACKFILL_AGENT_TOGGLES = Object.freeze(['architect', 'test_writer']);
function _applyAgentToggles(cfg) {
  const agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
  const added = [];
  for (const key of _BACKFILL_AGENT_TOGGLES) {
    if (agents[key] === undefined) {
      agents[key] = configDefaults.DEFAULT_AGENTS[key];
      added.push(key);
    }
  }
  if (added.length > 0) cfg.agents = agents;
  return added;
}

// Single-pass backfill used by the installer: one read, the economy default and
// the agent-toggle defaults applied together, one atomic write. Both backfills are
// loud (written to the file) and conservative (an explicit choice is never
// overwritten). Returns `{ economy, toggles }` for logging.
function _backfillConfigDefaults(stateDir, { dryRun = false } = {}) {
  const { cfgPath, cfg, status } = _loadConfigJson(stateDir);
  if (!cfg) return { economy: status, toggles: [] };
  const economy = _applyEconomyDefault(cfg);
  const toggles = _applyAgentToggles(cfg);
  if ((economy === 'backfilled' || toggles.length > 0) && !dryRun) {
    atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  return { economy, toggles };
}

// Standalone wrappers retained for unit tests. Each loads + writes on its own;
// the installer uses _backfillConfigDefaults to avoid a second read/write pass.
function _backfillEconomyDefault(stateDir, { dryRun = false } = {}) {
  const { cfgPath, cfg, status } = _loadConfigJson(stateDir);
  if (!cfg) return status;
  const action = _applyEconomyDefault(cfg);
  if (action === 'backfilled' && !dryRun) atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return action;
}

function _backfillAgentToggles(stateDir, { dryRun = false } = {}) {
  const { cfgPath, cfg } = _loadConfigJson(stateDir);
  if (!cfg) return [];
  const added = _applyAgentToggles(cfg);
  if (added.length > 0 && !dryRun) atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return added;
}

function _readExistingScope(projectRoot) {
  const cfg = _readInstallConfig(projectRoot);
  return cfg && cfg.scope ? cfg.scope : null;
}

function _readExistingRuntimes(projectRoot) {
  const cfg = _readInstallConfig(projectRoot);
  if (!cfg) return null;
  if (Array.isArray(cfg.runtimes) && cfg.runtimes.length) return cfg.runtimes.slice();
  if (cfg.runtime) return [cfg.runtime];
  return null;
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

function _readTextOrNull(file) {
  try { return fs.readFileSync(file, 'utf-8'); }
  catch { return null; }
}

function _advisorySnapshotPlan(opts) {
  const o = opts || {};
  const db = require('../lib/scan/advisory/db.cjs');
  const sourceDir = o.sourceDir || db.PACKAGE_DATA_DIR;
  const target = db.homeDbDir({ homedir: o.homedir, version: o.version });
  let manifest = null;
  try { manifest = db.loadManifest(sourceDir); }
  catch (err) {
    return { action: 'source-unreadable', sourceDir, target, cause: (err && err.code) || (err && err.message) };
  }
  if (!manifest) return { action: 'absent', sourceDir, target };
  const shards = Object.keys(manifest.sha256);
  const sourceRaw = _readTextOrNull(path.join(sourceDir, db.MANIFEST_FILE));
  const targetRaw = _readTextOrNull(path.join(target, db.MANIFEST_FILE));
  if (sourceRaw !== null && sourceRaw === targetRaw) {
    return { action: 'present', sourceDir, target, shards };
  }
  return { action: 'copy', sourceDir, target, shards, manifest, manifestRaw: sourceRaw };
}

function _installAdvisorySnapshot(opts) {
  const plan = _advisorySnapshotPlan(opts);
  if (plan.action !== 'copy') return plan;
  const db = require('../lib/scan/advisory/db.cjs');
  const manifestPath = path.join(plan.target, db.MANIFEST_FILE);
  fs.mkdirSync(plan.target, { recursive: true });
  try { fs.unlinkSync(manifestPath); } catch {}
  for (const shard of plan.shards) {
    try { fs.copyFileSync(path.join(plan.sourceDir, shard), path.join(plan.target, shard)); }
    catch (err) {
      try { fs.rmSync(plan.target, { recursive: true, force: true }); } catch {}
      return { action: 'copy-failed', sourceDir: plan.sourceDir, target: plan.target, shard, cause: err && err.message };
    }
  }
  const integrity = db.verifyIntegrity(plan.target, plan.manifest);
  if (!integrity.ok) {
    try { fs.rmSync(plan.target, { recursive: true, force: true }); } catch {}
    return {
      action: 'verify-failed',
      sourceDir: plan.sourceDir,
      target: plan.target,
      mismatches: integrity.mismatches,
      missing: integrity.missing,
    };
  }
  atomicWriteFileSync(manifestPath, plan.manifestRaw, 'utf-8', 0o644);
  return { action: 'copied', sourceDir: plan.sourceDir, target: plan.target, shards: plan.shards };
}

function _reportAdvisorySnapshot(result) {
  if (result.action === 'copied') {
    console.error(green + '  [advisory-db] ' + result.shards.length + ' Shards → ' + result.target + reset);
    return;
  }
  if (result.action === 'present') {
    console.error(dim + '  [advisory-db] bereits aktuell → ' + result.target + reset);
    return;
  }
  if (result.action === 'verify-failed' || result.action === 'copy-failed') {
    console.error(yellow + '  [advisory-db] Kopie verworfen (' + result.action + ') — '
      + 'der Scanner meldet die Lücke als Coverage-Gap; ' + result.target + ' wurde entfernt' + reset);
    return;
  }
  if (result.action === 'source-unreadable') {
    console.error(yellow + '  [advisory-db] Snapshot im Paket unlesbar (' + result.cause + ') — übersprungen' + reset);
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
    options: ['frontier', 'quality', 'balanced', 'budget', 'inherit'], default: 'frontier' })).value;
  const response_language = (await askUser({ type: 'input', question: 'Response language (ISO-639 code)?', default: 'en' })).value;
  // Wizard / --yes default is intentionally `false` (safer-by-default per
  // FIX-B2) even though the implicit code default lives at `true` in
  // DEFAULT_WORKFLOW (ADR-0004). The two are NOT in drift: explicit answer
  // overrides default; absent key falls back to ADR-0004 true. This is
  // covered by tests/install/install-flags.test.cjs:85.
  const commit_artifacts = (await askUser({ type: 'confirm',
    question: 'Auto-commit nubos-pilot planning artefacts (.nubos-pilot/ — milestones, roadmap, learnings) into your git repo?',
    default: false })).value;
  return configDefaults.buildInstallConfig({
    runtime, runtimes, scope,
    model_profile,
    response_language,
    commit_artifacts,
  });
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

const DEFAULT_CLAUDE_MD = '# CLAUDE.md\n\n'
  + 'Project guidance for Claude Code. Add project-specific instructions above the'
  + ' managed block — `npx nubos-pilot` only rewrites the block between the markers.\n';

function _rewriteManagedMarkdown(projectRoot, runtimes, responseLanguage) {
  const innerMd = _managedBlockInner(responseLanguage);
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  const claudeBase = fs.existsSync(claudePath)
    ? fs.readFileSync(claudePath, 'utf-8')
    : DEFAULT_CLAUDE_MD;
  const claudeRendered = managedBlockMod.rewriteBlock(claudeBase, innerMd);

  // No ['claude'] fallback: an empty list here used to mean "rewrite CLAUDE.md
  // and strip every other managed file", which is how a codex+gemini user lost
  // AGENTS.md/GEMINI.md. Callers must resolve a real list or abort (D2).
  if (!Array.isArray(runtimes) || runtimes.length === 0) {
    throw new NubosPilotError('install-runtimes-unreadable',
      'Refusing to rewrite managed markdown without a resolved runtime list',
      { got: Array.isArray(runtimes) ? 'empty-array' : typeof runtimes });
  }
  const ids = runtimes;
  const written = new Set();
  for (const id of ids) {
    if (id === 'opencode') continue;
    const meta = registryMod.getRuntimeMeta(id);
    if (!meta) continue;
    const targetPath = registryMod.runtimeAgentsPath(meta, 'local', projectRoot);
    if (written.has(targetPath)) continue;
    written.add(targetPath);

    if (id === 'claude' && path.resolve(targetPath) === path.resolve(claudePath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      atomicWriteFileSync(targetPath, claudeRendered);
      continue;
    }

    const base = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, 'utf-8')
      : agentsMdMod.generateAgentsMd(claudeRendered, id);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, managedBlockMod.rewriteBlock(base, innerMd));
  }

  const stalePaths = [claudePath, path.join(projectRoot, 'AGENTS.md'), path.join(projectRoot, 'GEMINI.md')];
  for (const p of stalePaths) {
    if (written.has(p)) continue;
    if (!fs.existsSync(p)) continue;
    const current = fs.readFileSync(p, 'utf-8');
    const stripped = managedBlockMod.stripBlock(current);
    if (stripped.trim().length === 0) {
      try { fs.unlinkSync(p); } catch {}
    } else if (stripped !== current) {
      atomicWriteFileSync(p, stripped);
    }
  }
}

// Manifest of what WOULD be installed, hashed straight off the source tree.
// _copyTree tolerates a missing sourceDir (staging then yields an empty payload),
// so mirror that here instead of throwing manifest-build-failed.
function _manifestForSource(sourceDir, pkgVersion) {
  if (!fs.existsSync(sourceDir)) {
    return { version: String(pkgVersion), timestamp: new Date().toISOString(), files: {} };
  }
  return manifestMod.buildManifest(sourceDir, pkgVersion);
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
  const ctx = {
    projectRoot, mode, dryRun, askUser, sourceDir, stateDir, flags,
    advisorySourceDir: o.advisorySourceDir || null,
    advisoryHomedir: o.advisoryHomedir || null,
  };
  // A dry-run is strictly read-only: it creates neither the state dir nor the
  // lock file, and never stages the payload (D4). Nothing to serialise against.
  if (dryRun) return _runInstallLocked(ctx);
  fs.mkdirSync(stateDir, { recursive: true });
  return withFileLock(path.join(stateDir, '.install.lock'),
    () => _runInstallLocked(ctx),
    { timeoutMs: 60000 });
}

async function _runInstallLocked(ctx) {
  const { projectRoot, mode, dryRun, askUser, sourceDir, stateDir, flags,
    advisorySourceDir, advisoryHomedir } = ctx;
  _printBanner();
  console.error(cyan + '→ nubos-pilot install (mode=' + mode + ')' + reset);

  const preliminaryScope = (flags && flags.scope) || _readExistingScope(projectRoot) || 'local';
  const preliminaryBase = preliminaryScope === 'global' ? os.homedir() : projectRoot;
  // rmSync of a stale staging dir is a write — a preview does not clean up.
  if (!dryRun) stagingMod.cleanStaleStaging(preliminaryBase);

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
  } else {
    // Re-install / update: backfill the default agent config into a config that
    // doesn't set it yet (one read/write, never overwriting an explicit choice).
    const { economy, toggles } = _backfillConfigDefaults(stateDir, { dryRun });
    if (economy === 'backfilled') {
      console.error(green + '  [config] agents.economy → ' + configDefaults.INSTALL_ECONOMY_MODE + ' (backfilled default)'
        + (dryRun ? ' [DRY-RUN]' : '') + reset);
    }
    for (const key of toggles) {
      console.error(green + '  [config] agents.' + key + ' → ' + configDefaults.DEFAULT_AGENTS[key] + ' (backfilled default)'
        + (dryRun ? ' [DRY-RUN]' : '') + reset);
    }
  }

  const resolvedScope = (initConfig && initConfig.scope) || preliminaryScope;
  const payloadBase = resolvedScope === 'global' ? os.homedir() : projectRoot;
  const payloadDir = _payloadDirFor(projectRoot, resolvedScope);

  // Resolve the runtime list BEFORE anything is staged, so a refusal leaves no
  // debris behind. _readExistingRuntimes returns null for a config whose
  // `runtimes` is missing, empty or mistyped; that used to degrade to ['claude']
  // downstream and quietly destroy the user's managed files (D2). An existing
  // install that cannot say which runtimes it serves is a broken install — say so.
  const selectedRuntimesEarly = (initConfig && initConfig.runtimes)
    || (initConfig ? [initConfig.runtime] : null)
    || _readExistingRuntimes(projectRoot)
    || [];
  if (selectedRuntimesEarly.length === 0) {
    throw new NubosPilotError('install-runtimes-unreadable',
      'install refused — no runtime list could be read from .nubos-pilot/config.json'
        + ' (key `runtimes` missing, empty, or not an array of runtime ids).'
        + ' Repair the file, or remove .nubos-pilot/config.json and re-run'
        + ' `npx nubos-pilot` for a fresh init.',
      { mode, configPath: path.join(STATE_SUBPATH, 'config.json') });
  }
  const opencodeSelected = selectedRuntimesEarly.includes('opencode');

  const oldManifest = manifestMod.readManifest(payloadDir);
  let pkgVersion = '0.0.0';
  try { pkgVersion = String(require('../package.json').version || '0.0.0'); } catch {}
  // A dry-run must not stage: hashing the source tree yields the same manifest
  // without writing a single byte (D4).
  const tmp = dryRun ? null : stagingMod.stageDir(payloadBase);
  if (!dryRun) _copyTree(sourceDir, tmp);
  const newManifest = dryRun
    ? _manifestForSource(sourceDir, pkgVersion)
    : manifestMod.buildManifest(tmp, pkgVersion);

  const assetPlans = runtimeAssetsMod.planRuntimeAssets({
    selectedRuntimes: selectedRuntimesEarly,
    scope: resolvedScope,
    projectRoot,
    workflowsDir: SOURCE_WORKFLOWS_DIR,
    agentsDir: SOURCE_AGENTS_DIR,
    skillsDir: SOURCE_SKILLS_DIR,
  });
  const assetEntries = runtimeAssetsMod.manifestEntriesForPlans(assetPlans);
  for (const k of Object.keys(assetEntries)) {
    newManifest.files[k] = assetEntries[k];
  }

  const opencodeTarget = _opencodePayloadDirFor(projectRoot, resolvedScope);
  const opencodeManifestPrefix = _opencodeManifestPrefix(resolvedScope);
  const opencodeTmp = path.join(stateDir, '.opencode.tmp');
  if (!dryRun) { try { fs.rmSync(opencodeTmp, { recursive: true, force: true }); } catch {} }
  try {
  let opencodeManifest = null;
  if (opencodeSelected && fs.existsSync(SOURCE_OPENCODE_DIR)) {
    if (!dryRun) _copyTree(SOURCE_OPENCODE_DIR, opencodeTmp);
    opencodeManifest = dryRun
      ? _manifestForSource(SOURCE_OPENCODE_DIR, pkgVersion)
      : manifestMod.buildManifest(opencodeTmp, pkgVersion);
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
  // Backups must live OUTSIDE payloadDir: finalizeSwap renames payloadDir aside
  // and rmSync's it, which would destroy any sibling .bak along with it.
  const backupRoot = path.join(projectRoot, STATE_SUBPATH, 'backups',
    new Date().toISOString().replace(/[:.]/g, '-'));
  for (const rel of diff.changed) {
    const existing = path.join(payloadDir, rel);
    if (!fs.existsSync(existing)) continue;
    let existingHash = null;
    let oldHash = null;
    try {
      existingHash = manifestMod.fileHashSync(existing);
      oldHash = (oldManifest && oldManifest.files && oldManifest.files[rel]) || null;
    } catch {
      continue;
    }
    if (!oldHash || existingHash === oldHash) continue;
    if (dryRun) {
      backupLog.push({ rel, backedUp: null });
      console.error(dim + 'DRY-RUN: würde sichern ' + rel + reset);
      continue;
    }
    const backedUp = backupMod.backupFile(existing, { destDir: backupRoot, relPath: rel });
    backupLog.push({ rel, backedUp });
    console.error(yellow + '  [conflict] ' + rel + ' → '
      + path.relative(projectRoot, backedUp) + reset);
  }

  if (dryRun) {
    let advisoryPlan = { action: 'absent' };
    try {
      advisoryPlan = _advisorySnapshotPlan({
        sourceDir: advisorySourceDir, homedir: advisoryHomedir, version: pkgVersion,
      });
    } catch {}
    if (advisoryPlan.action === 'copy') {
      console.error(dim + 'DRY-RUN: würde Advisory-Snapshot kopieren → ' + advisoryPlan.target + reset);
    }
    const summary = { mode, dryRun: true,
      scope: resolvedScope,
      wouldWrite: Object.keys(newManifest.files).length,
      wouldBackup: backupLog.length, wouldDelete: diff.stale.length,
      wouldWriteGemini: selectedRuntimesEarly.includes('gemini'),
      wouldWriteOpencodeJson: opencodeSelected && !fs.existsSync(path.join(projectRoot, 'opencode.json')),
      wouldCopyAdvisoryDb: advisoryPlan.action === 'copy',
      stale: diff.stale, changed: diff.changed, added: diff.added };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    // Nothing was staged, so there is nothing to clean up.
    return summary;
  }

  if (fs.existsSync(payloadDir) && fs.lstatSync(payloadDir).isSymbolicLink()) {
    try { stagingMod.cleanStaleStaging(payloadBase); } catch {}
    throw new NubosPilotError('target-is-symlink',
      'Refusing to swap into a symlink target: ' + payloadDir, { payloadDir });
  }

  stagingMod.finalizeSwap(payloadBase);
  const resolvedPayloadDir = path.resolve(payloadDir);
  for (const rel of diff.stale) {
    manifestMod.assertSafeManifestKey(rel, 'install-stale-cleanup');
    const abs = path.join(payloadDir, rel);
    const resolvedAbs = path.resolve(abs);
    if (!(resolvedAbs === resolvedPayloadDir || resolvedAbs.startsWith(resolvedPayloadDir + path.sep))) {
      throw new NubosPilotError(
        'manifest-unlink-outside-base',
        'Refusing unlink that escapes payloadDir',
        { rel, base: path.basename(payloadDir) },
      );
    }
    try { fs.unlinkSync(abs); } catch {}
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
        manifestMod.assertSafeManifestKey(rel, 'install-opencode-stale');
        const relFs = rel.startsWith('~/')
          ? path.join(os.homedir(), rel.slice(2))
          : path.join(opencodeBase, rel);
        const expectedBase = rel.startsWith('~/') ? os.homedir() : opencodeBase;
        const resolvedRelFs = path.resolve(relFs);
        const resolvedExpected = path.resolve(expectedBase);
        if (!(resolvedRelFs === resolvedExpected || resolvedRelFs.startsWith(resolvedExpected + path.sep))) {
          throw new NubosPilotError(
            'manifest-unlink-outside-base',
            'Refusing opencode unlink that escapes its base',
            { rel, base: path.basename(expectedBase) },
          );
        }
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

  // Reuse selectedRuntimesEarly — it carries the _readExistingRuntimes fallback.
  // This site used to recompute the list without it, and `initConfig` is null for
  // every non-init mode, so a re-install saw []. _rewriteManagedMarkdown treats
  // an empty list as ['claude'], which stripped the managed block out of
  // AGENTS.md/GEMINI.md (deleting the file when it held nothing else) and created
  // an unwanted CLAUDE.md. response_language collapsed to English the same way.
  const selectedRuntimes = selectedRuntimesEarly;
  const existingConfig = initConfig || _readInstallConfig(projectRoot);
  const responseLanguage = existingConfig && existingConfig.response_language;
  _rewriteManagedMarkdown(projectRoot, selectedRuntimes, responseLanguage);

  if (assetPlans.length) {
    runtimeAssetsMod.writeRuntimeAssets(assetPlans);
  }
  const assetStale = diff.stale.filter(runtimeAssetsMod.isAssetManifestKey);
  if (assetStale.length) {
    runtimeAssetsMod.removeStaleAssets(assetStale, resolvedScope, projectRoot);
  }

  try { _writeToolsShim(projectRoot); } catch (err) {
    console.error(yellow + '  [shim] np-tools shim skipped: ' + (err && err.message) + reset);
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
  try {
    _reportAdvisorySnapshot(_installAdvisorySnapshot({
      sourceDir: advisorySourceDir, homedir: advisoryHomedir, version: pkgVersion,
    }));
  } catch (err) {
    console.error(yellow + '  [advisory-db] übersprungen: ' + (err && err.message) + reset);
  }
  if (selectedRuntimesEarly.includes('claude')) {
    try {
      const claudeHooks = require('../lib/install/claude-hooks.cjs');
      const res = claudeHooks.installClaudeHooks({
        projectRoot, scope: resolvedScope, which: 'all', force: false,
      });
      const secAction = res.results.security
        ? Object.values(res.results.security).every((r) => r.action === 'installed') ? 'installed'
          : Object.values(res.results.security).every((r) => r.action === 'updated') ? 'updated' : 'mixed'
        : 'skipped';
      console.error(dim + '  [claude-hooks] statusline: ' + res.results.statusline.action
        + ', ctx-monitor: ' + res.results.ctxMonitor.action
        + ', security: ' + secAction + reset);
      if (res.results.statusline.action === 'skipped-existing') {
        console.error(yellow + '  [claude-hooks] foreign statusLine preserved — re-run `install-hooks --force` to overwrite' + reset);
      }
    } catch (err) {
      console.error(yellow + '  [claude-hooks] skipped: ' + (err && err.message) + reset);
    }
  }
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
  const dryRun = !!options.dryRun;
  // A dry-run is a read-only preview, so it takes neither of the two writes the
  // real path needs: it does not create the state dir and does not take the
  // install lock (there is nothing to serialise against).
  if (dryRun) return _runUninstallLocked(projectRoot, true);
  const stateDir = _stateDirFor(projectRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, '.install.lock');
  return withFileLock(lockPath, () => _runUninstallLocked(projectRoot, false),
    { timeoutMs: 60000 });
}

// dryRun threads through a SINGLE code path rather than a parallel "planner", so
// the preview cannot drift from what the real uninstall does. Every fs mutation
// below is guarded; each guard records the action it skipped.
function _runUninstallLocked(projectRoot, dryRun) {
  const scope = _readExistingScope(projectRoot) || 'local';
  const payloadDir = _payloadDirFor(projectRoot, scope);
  const manifest = manifestMod.readManifest(payloadDir);
  const plan = [];
  const relTo = (p) => path.relative(projectRoot, p) || path.basename(p);
  if (!manifest) {
    console.error(dim + 'Keine Installation gefunden' + reset);
    return dryRun
      ? { uninstalled: false, dryRun: true, scope, wouldRemove: [] }
      : { uninstalled: false };
  }

  // Reuse the SAME validator as readManifest so a legitimate key like
  // `..bar` (no traversal segment) isn't false-rejected here while passing
  // validation upstream. Single source of truth lives in manifest.cjs.
  for (const rel of Object.keys(manifest.files)) {
    manifestMod.assertSafeManifestKey(rel, 'uninstall');
  }

  const payloadBase = scope === 'global' ? os.homedir() : projectRoot;
  let removed = 0;
  const assetDirs = new Set();
  for (const rel of Object.keys(manifest.files)) {
    const isAsset = runtimeAssetsMod.isAssetManifestKey(rel);
    const abs = rel.startsWith('~/')
      ? path.join(os.homedir(), rel.slice(2))
      : isAsset ? path.join(payloadBase, rel) : path.join(payloadDir, rel);
    // Defense-in-depth: even with the validator above, ensure the resolved
    // path lives inside its expected base. A symlink or future-validator
    // regression cannot escape this prefix check.
    const expectedBase = rel.startsWith('~/') ? os.homedir()
      : isAsset ? payloadBase : payloadDir;
    const resolvedAbs = path.resolve(abs);
    const resolvedBase = path.resolve(expectedBase);
    if (!(resolvedAbs === resolvedBase || resolvedAbs.startsWith(resolvedBase + path.sep))) {
      throw new NubosPilotError(
        'manifest-unlink-outside-base',
        'Refusing unlink that escapes its payload base',
        { rel, base: path.basename(expectedBase) },
      );
    }
    if (dryRun) {
      if (fs.existsSync(abs)) plan.push('remove ' + relTo(abs));
      continue;
    }
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
  const sortedDirs = dryRun ? [] : Array.from(assetDirs).sort((a, b) => b.length - a.length);
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

  if (dryRun) {
    const mf = path.join(payloadDir, '.manifest.json');
    if (fs.existsSync(mf)) plan.push('remove ' + relTo(mf));
  } else {
    try { fs.unlinkSync(path.join(payloadDir, '.manifest.json')); } catch {}
    try { fs.rmdirSync(payloadDir); } catch {}
  }

  let installedRuntimes = [];
  const cfg = _readInstallConfig(projectRoot);
  if (cfg) {
    installedRuntimes = cfg.runtimes || (cfg.runtime ? [cfg.runtime] : []);
  }

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
    const current = fs.readFileSync(p, 'utf-8');
    const stripped = managedBlockMod.stripBlock(current);
    const emptied = !stripped || !stripped.trim();
    if (dryRun) {
      if (emptied) plan.push('remove ' + relTo(p));
      else if (stripped !== current) plan.push('strip managed block from ' + relTo(p));
      continue;
    }
    if (emptied) {
      try { fs.unlinkSync(p); } catch {}
    } else {
      atomicWriteFileSync(p, stripped);
    }
  }

  const opencodeDir = _opencodePayloadDirFor(projectRoot, scope);
  if (dryRun) {
    if (fs.existsSync(opencodeDir)) plan.push('remove ' + relTo(opencodeDir) + '/');
  } else {
    if (fs.existsSync(opencodeDir)) {
      try { fs.rmSync(opencodeDir, { recursive: true, force: true }); } catch {}
    }
    const opencodeParent = path.dirname(opencodeDir);
    try { fs.rmdirSync(opencodeParent); } catch {}
  }

  // Uninstall deleted the hook SCRIPTS but never their registrations, so all 8
  // hooks + statusLine kept pointing at files that no longer exist and fired on
  // every session. The guard is marker-safe — it only removes nubos entries.
  let hooksRemoved = null;
  try {
    const claudeHooks = require('../lib/install/claude-hooks.cjs');
    hooksRemoved = claudeHooks.uninstallClaudeHooks({ projectRoot, scope, dryRun });
    if (dryRun) plan.push('deregister hooks in ' + path.basename(hooksRemoved.path));
    else {
      console.error(dim + '  [hooks] Registrierungen entfernt ← '
        + path.basename(hooksRemoved.path) + reset);
    }
  } catch (err) {
    console.error(yellow + '  [hooks] Deregistrierung übersprungen: ' + (err && err.message) + reset);
  }

  // The shims are written by _writeToolsShim but never entered into the manifest,
  // so the unlink loop above could not see them.
  const shimDir = path.join(projectRoot, STATE_SUBPATH, 'bin');
  for (const spec of PROJECT_BIN_SHIMS) {
    const shimPath = path.join(shimDir, spec.name);
    if (dryRun) {
      if (fs.existsSync(shimPath)) plan.push('remove ' + relTo(shimPath));
      continue;
    }
    try { fs.unlinkSync(shimPath); removed++; } catch {}
  }
  if (!dryRun) { try { fs.rmdirSync(shimDir); } catch {} }

  if (dryRun) {
    const summary = { uninstalled: false, dryRun: true, scope, wouldRemove: plan };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  console.error(green + '✓ Uninstall abgeschlossen' + reset);
  // Conflict backups live under .nubos-pilot/backups/<ts>/ (outside the payload
  // dir, so they survive the swap) — report them from there, not from payloadDir.
  let leftovers = [];
  try {
    const backupsRoot = path.join(projectRoot, STATE_SUBPATH, 'backups');
    if (fs.existsSync(backupsRoot)) {
      leftovers = fs.readdirSync(backupsRoot);
    }
  } catch {}
  if (leftovers.length) {
    console.error(dim + '  User-Backups belassen:' + reset);
    for (const f of leftovers) console.error(dim + '    ' + f + reset);
  }
  return { uninstalled: true, removed, leftoverBaks: leftovers };
}

// Which global flags each subcommand actually CONSUMES. A flag the parser
// accepts but nobody reads is the trap D1 was made of: --dry-run was documented,
// parsed, and then dropped on the only destructive command. So the rule is
// mechanical — if a subcommand cannot honour a flag, it must reject it loudly
// rather than swallow it. Extend this table whenever a flag or subcommand is
// added; an unlisted subcommand (`doctor`) accepts no global flags at all.
const SUBCOMMAND_FLAGS = Object.freeze({
  install: ['agent', 'agents', 'scope', 'yes', 'dryRun'],
  update: ['agent', 'agents', 'scope', 'yes', 'dryRun'],
  uninstall: ['dryRun'],
  doctor: [],
  'install-hooks': ['scope', 'dryRun'],
  'uninstall-hooks': ['scope', 'dryRun'],
});

const _FLAG_CLI_NAME = Object.freeze({
  agent: '--agent', agents: '--agents/--all', scope: '--scope',
  yes: '--yes', dryRun: '--dry-run',
});

function _setFlagKeys(flags) {
  const keys = [];
  // --agents/--all also derive flags.agent; report the flag the user actually typed.
  if (flags.agents !== null) keys.push('agents');
  else if (flags.agent !== null) keys.push('agent');
  if (flags.scope !== null) keys.push('scope');
  if (flags.yes) keys.push('yes');
  if (flags.dryRun) keys.push('dryRun');
  return keys;
}

function _rejectUnsupportedFlags(sub, flags) {
  const key = sub === undefined ? 'install' : sub;
  const allowed = SUBCOMMAND_FLAGS[key];
  if (!allowed) return; // unknown subcommand: the dispatch default rejects it
  const bad = _setFlagKeys(flags)
    .filter((k) => !allowed.includes(k))
    .map((k) => _FLAG_CLI_NAME[k]);
  if (bad.length === 0) return;
  process.stderr.write(
    red + '`' + key + '` unterstützt ' + bad.join(', ') + ' nicht.' + reset + '\n'
    + dim + 'Ein Flag, das nicht ankommt, wird nicht stillschweigend ignoriert.'
    + (allowed.length
      ? ' Erlaubt: ' + allowed.map((k) => _FLAG_CLI_NAME[k]).join(', ')
      : ' Dieses Subcommand nimmt keine dieser Flags.')
    + reset + '\n',
  );
  process.exit(1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    let version = '0.0.0';
    try { version = String(require('../package.json').version || '0.0.0'); } catch {}
    process.stdout.write(version + '\n');
    return;
  }
  const { flags, rest } = parseInstallFlags(rawArgs);
  const sub = rest[0];
  const cwd = process.cwd();
  // Subcommands below take no positional args. Anything left in rest is a
  // typo or an unsupported flag — reject it instead of silently ignoring it.
  const _rejectExtraArgs = () => {
    if (rest.length > 1) {
      process.stderr.write(
        red + 'Unbekannte Argumente: ' + rest.slice(1).join(' ') + reset + '\n',
      );
      process.exit(1);
    }
  };
  _rejectUnsupportedFlags(sub, flags);
  switch (sub) {
    case undefined:
      return await runInstall({ cwd, mode: detectMode(cwd), dryRun: flags.dryRun, flags });
    case 'update': {
      _rejectExtraArgs();
      const detected = detectMode(cwd);
      return await runInstall({
        cwd, mode: detected === 'init' ? 'init' : 'update', dryRun: flags.dryRun, flags,
      });
    }
    case 'uninstall':
      // uninstall was the one destructive subcommand that neither rejected extra
      // args nor forwarded dryRun — a documented flag the user rightly trusted
      // was parsed, dropped, and the real uninstall ran (D1).
      _rejectExtraArgs();
      return await runUninstall({ cwd, dryRun: flags.dryRun });
    case 'doctor': {
      const doctor = require('./np-tools/doctor.cjs');
      // main()'s resolved value is discarded by the top-level catch wrapper, so
      // carry doctor's exit code out explicitly.
      const code = await doctor.run(rest.slice(1), { cwd, stdout: process.stdout });
      if (typeof code === 'number' && code !== 0) process.exitCode = code;
      return code;
    }
    case 'install-hooks':
      // parseInstallFlags consumes --scope before _parseHookFlags can see it, so
      // the dispatch must forward it — it used to be swallowed and the hooks
      // silently landed in the wrong scope (D1 class).
      return await runInstallHooks({
        cwd, args: rest.slice(1), dryRun: flags.dryRun, scope: flags.scope,
      });
    case 'uninstall-hooks':
      return await runUninstallHooks({
        cwd, args: rest.slice(1), dryRun: flags.dryRun, scope: flags.scope,
      });
    default:
      process.stderr.write(
        red + 'Unbekanntes Subcommand: ' + sub + reset + '\n',
      );
      process.exit(1);
      return undefined;
  }
}

function _parseHookFlags(args) {
  const flags = { scope: null, which: 'both', force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scope' || a === '-s') { flags.scope = args[++i] || null; continue; }
    if (a.startsWith('--scope=')) { flags.scope = a.slice('--scope='.length); continue; }
    if (a === '--statusline-only') { flags.which = 'statusline'; continue; }
    if (a === '--ctx-monitor-only') { flags.which = 'ctx-monitor'; continue; }
    if (a === '--force' || a === '-f') { flags.force = true; continue; }
    if (a === '--dry-run') { flags.dryRun = true; continue; }
  }
  if (flags.scope && !VALID_SCOPES.includes(flags.scope)) {
    throw new NubosPilotError('invalid-flag',
      '--scope must be one of: ' + VALID_SCOPES.join(', '),
      { flag: '--scope', got: flags.scope });
  }
  return flags;
}

async function runInstallHooks(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || o.cwd || process.cwd();
  const flags = _parseHookFlags(o.args || []);
  // parseInstallFlags consumes --scope/--dry-run before the subcommand sees them,
  // so honour the forwarded values too.
  const scope = flags.scope || o.scope || _readExistingScope(projectRoot) || 'local';
  const dryRun = flags.dryRun || !!o.dryRun;
  const claudeHooks = require('../lib/install/claude-hooks.cjs');
  const res = claudeHooks.installClaudeHooks({
    projectRoot, scope, which: flags.which, force: flags.force, dryRun,
  });
  if (res.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, path: res.path, results: res.results }, null, 2) + '\n');
    return res;
  }
  console.error(green + '✓ Claude Code hooks geschrieben → ' + res.path + reset);
  if (res.results.statusline) {
    console.error(dim + '  statusline: ' + res.results.statusline.action
      + (res.results.statusline.existingCommand ? ' (existing: ' + res.results.statusline.existingCommand + ')' : '')
      + reset);
  }
  if (res.results.ctxMonitor) {
    console.error(dim + '  ctx-monitor: ' + res.results.ctxMonitor.action + reset);
  }
  if (res.results.statusline && res.results.statusline.action === 'skipped-existing') {
    console.error(yellow + '  [statusline] existing non-nubos statusLine preserved. Pass --force to overwrite.' + reset);
  }
  return res;
}

async function runUninstallHooks(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || o.cwd || process.cwd();
  const flags = _parseHookFlags(o.args || []);
  const scope = flags.scope || o.scope || _readExistingScope(projectRoot) || 'local';
  const dryRun = flags.dryRun || !!o.dryRun;
  const claudeHooks = require('../lib/install/claude-hooks.cjs');
  const res = claudeHooks.uninstallClaudeHooks({ projectRoot, scope, dryRun });
  if (res.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, path: res.path, results: res.results }, null, 2) + '\n');
    return res;
  }
  console.error(green + '✓ Claude Code hooks entfernt ← ' + res.path + reset);
  console.error(dim + '  statusline: ' + res.results.statusline.action + reset);
  console.error(dim + '  ctx-monitor: ' + res.results.ctxMonitor.action + reset);
  return res;
}

if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    process.stderr.write('nubos-pilot: requires Node >= 22 (running ' + process.versions.node + ')\n');
    process.exit(1);
  }
  installSignalCleanup();
  main().catch((err) => {
    const payload = (err && err.code)
      ? JSON.stringify({ error: { code: err.code, message: err.message, details: err.details || null } }) + '\n'
      : ((err && err.stack) || String(err)) + '\n';
    // Drain stderr before exit. process.exit() can otherwise tear down the
    // pipe mid-flush on busy CI, truncating the envelope. Set exitCode and
    // let Node drain naturally; force-exit only as a last-resort fallback.
    try { process.stderr.write(payload); } catch {}
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000).unref();
  });
}

module.exports = {
  runInstall, runUninstall, detectMode, main,
  parseInstallFlags,
  VALID_AGENTS, VALID_SCOPES,
  SOURCE_PAYLOAD_DIR, PAYLOAD_SUBPATH, STATE_SUBPATH,
  _payloadDirFor, _stateDirFor,
  _backfillEconomyDefault, _backfillAgentToggles, _backfillConfigDefaults,
};

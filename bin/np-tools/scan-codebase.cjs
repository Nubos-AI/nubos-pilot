const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { scan } = require('../../lib/workspace-scan.cjs');
const { workspaceGitInfo } = require('../../lib/git.cjs');
const {
  manifestFromScanFiles,
  writeManifest,
  readManifest,
} = require('../../lib/codebase-manifest.cjs');
const {
  groupFilesIntoModules,
  buildModuleFacts,
  renderModuleDoc,
  buildIndexDoc,
  buildDocIndexMap,
  moduleDocPath,
  indexDocPath,
} = require('../../lib/codebase-docs.cjs');

function _parseArgs(args) {
  const flags = {
    cwd: null,
    batchSize: 500,
    maxFiles: 0,
    applyProse: false,
    moduleId: null,
    proseFile: null,
    emitPlan: true,
    projectName: null,
  };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (a === '--cwd') flags.cwd = args[++i];
    else if (a === '--batch-size') flags.batchSize = parseInt(args[++i], 10);
    else if (a === '--max-files') flags.maxFiles = parseInt(args[++i], 10);
    else if (a === '--apply-prose') { flags.applyProse = true; flags.emitPlan = false; }
    else if (a === '--module') flags.moduleId = args[++i];
    else if (a === '--prose-file') flags.proseFile = args[++i];
    else if (a === '--project-name') flags.projectName = args[++i];
  }
  return flags;
}

function _hashesLookupFromManifest(manifest) {
  const lookup = {};
  for (const [p, meta] of Object.entries(manifest.files || {})) {
    lookup[p] = meta.sha256;
  }
  return lookup;
}

function _emitPlan(projectRoot, flags, stdout) {
  const modulesResult = _scanAndBuild(projectRoot, flags);
  stdout.write(JSON.stringify({
    mode: 'plan',
    cwd: projectRoot,
    stats: modulesResult.scan.stats,
    git: modulesResult.scan.git,
    language_distribution: modulesResult.scan.language_distribution,
    manifests: Object.keys(modulesResult.scan.manifests).sort(),
    docs: Object.keys(modulesResult.scan.docs).sort(),
    modules: modulesResult.modules.map((m) => ({
      id: m.id,
      directory: m.directory,
      primary_language: m.primary_language,
      file_count: m.file_count,
      facts: m.facts,
    })),
    index_path: path.relative(projectRoot, indexDocPath(projectRoot)),
    manifest_path: path.relative(
      projectRoot,
      path.join(projectRoot, '.nubos-pilot', 'codebase', '.hashes.json'),
    ),
  }, null, 2));
}

function _scanAndBuild(projectRoot, flags) {
  const scanResult = scan({
    cwd: projectRoot,
    batchSize: flags.batchSize,
    maxFiles: flags.maxFiles > 0 ? flags.maxFiles : undefined,
    gitInfo: workspaceGitInfo,
  });

  const groups = groupFilesIntoModules(scanResult.files);
  const modules = groups.map((g) => {
    const facts = buildModuleFacts(g, projectRoot);
    return Object.assign({}, g, { facts });
  });

  const manifest = manifestFromScanFiles(scanResult.files);
  writeManifest(projectRoot, manifest);

  const indexMapPath = path.join(
    projectRoot,
    '.nubos-pilot',
    'codebase',
    '.doc-index.json',
  );
  const docIndex = buildDocIndexMap(modules);
  fs.mkdirSync(path.dirname(indexMapPath), { recursive: true });
  atomicWriteFileSync(indexMapPath, JSON.stringify(docIndex, null, 2) + '\n');

  const indexPath = indexDocPath(projectRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  atomicWriteFileSync(indexPath, buildIndexDoc(modules, { project_name: flags.projectName || null }));

  const hashLookup = _hashesLookupFromManifest(manifest);
  for (const mod of modules) {
    const docPath = moduleDocPath(projectRoot, mod.id);
    if (fs.existsSync(docPath)) continue;
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    atomicWriteFileSync(docPath, renderModuleDoc(mod.facts, null, hashLookup));
  }

  return { scan: scanResult, modules, manifest, hashLookup };
}

function _applyProse(projectRoot, flags, stdout) {
  if (!flags.moduleId) {
    throw new NubosPilotError(
      'scan-codebase-missing-module',
      '--apply-prose requires --module <id>',
      {},
    );
  }
  if (!flags.proseFile) {
    throw new NubosPilotError(
      'scan-codebase-missing-prose',
      '--apply-prose requires --prose-file <path>',
      {},
    );
  }
  let prose;
  try {
    prose = JSON.parse(fs.readFileSync(flags.proseFile, 'utf-8'));
  } catch (err) {
    throw new NubosPilotError(
      'scan-codebase-prose-unreadable',
      'prose file not readable or not valid JSON: ' + flags.proseFile,
      { path: flags.proseFile, cause: err && err.message },
    );
  }

  const scanResult = scan({
    cwd: projectRoot,
    batchSize: flags.batchSize,
    maxFiles: flags.maxFiles > 0 ? flags.maxFiles : undefined,
    gitInfo: workspaceGitInfo,
  });
  const groups = groupFilesIntoModules(scanResult.files);
  const target = groups.find((g) => g.id === flags.moduleId);
  if (!target) {
    throw new NubosPilotError(
      'scan-codebase-module-not-found',
      `module not found: ${flags.moduleId}`,
      { moduleId: flags.moduleId },
    );
  }

  const facts = buildModuleFacts(target, projectRoot);
  const manifest = manifestFromScanFiles(scanResult.files);
  const hashLookup = _hashesLookupFromManifest(manifest);

  const docPath = moduleDocPath(projectRoot, target.id);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  const rendered = renderModuleDoc(facts, prose, hashLookup);
  atomicWriteFileSync(docPath, rendered);

  writeManifest(projectRoot, manifest);

  stdout.write(JSON.stringify({
    mode: 'apply-prose',
    module_id: target.id,
    doc_path: path.relative(projectRoot, docPath),
    symbol_count: facts.symbols.length,
  }, null, 2));
}

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const flags = _parseArgs(args);
  const projectRoot = path.resolve(flags.cwd || context.cwd || process.cwd());

  const stateDir = path.join(projectRoot, '.nubos-pilot');
  if (!fs.existsSync(stateDir)) {
    throw new NubosPilotError(
      'scan-codebase-not-initialized',
      '.nubos-pilot/ not found — run np:new-project first',
      { cwd: projectRoot },
    );
  }

  if (flags.applyProse) {
    _applyProse(projectRoot, flags, stdout);
  } else {
    _emitPlan(projectRoot, flags, stdout);
  }
}

module.exports = { run, _parseArgs };

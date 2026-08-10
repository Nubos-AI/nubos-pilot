const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { scan } = require('../../lib/workspace-scan.cjs');
const { workspaceGitInfo } = require('../../lib/git.cjs');
const {
  manifestFromScanFiles,
  writeManifest,
  readManifest,
  diffManifest,
  stalePathsForDocs,
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
    paths: [],
  };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (a === '--cwd') flags.cwd = args[++i];
    else if (a === '--batch-size') flags.batchSize = parseInt(args[++i], 10);
    else if (a === '--max-files') flags.maxFiles = parseInt(args[++i], 10);
    else if (a === '--apply-prose') flags.applyProse = true;
    else if (a === '--module') flags.moduleId = args[++i];
    else if (a === '--prose-file') flags.proseFile = args[++i];
    else if (a === '--path') flags.paths.push(args[++i]);
  }
  return flags;
}

function _readDocIndex(projectRoot) {
  const p = path.join(projectRoot, '.nubos-pilot', 'codebase', '.doc-index.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function _hashesLookupFromManifest(manifest) {
  const lookup = {};
  for (const [p, meta] of Object.entries(manifest.files || {})) {
    lookup[p] = meta.sha256;
  }
  return lookup;
}

function _emitPlan(projectRoot, flags, stdout) {
  const prev = readManifest(projectRoot);
  const scanResult = scan({
    cwd: projectRoot,
    batchSize: flags.batchSize,
    maxFiles: flags.maxFiles > 0 ? flags.maxFiles : undefined,
    gitInfo: workspaceGitInfo,
  });
  const next = manifestFromScanFiles(scanResult.files);
  const diff = diffManifest(prev, next);

  const docIndex = _readDocIndex(projectRoot);
  const staleInfo = stalePathsForDocs(diff, docIndex);

  const groups = groupFilesIntoModules(scanResult.files);
  const modulesById = new Map();
  for (const g of groups) modulesById.set(g.id, g);

  const staleModules = [];
  for (const docPath of staleInfo.stale_docs) {
    const parsedId = path.posix.basename(docPath).replace(/\.md$/, '');
    const group = modulesById.get(parsedId);
    if (!group) continue;
    const facts = buildModuleFacts(group, projectRoot);
    staleModules.push({
      id: group.id,
      directory: group.directory,
      doc_path: docPath,
      facts,
    });
  }

  const hashLookup = _hashesLookupFromManifest(next);
  const removedModules = [];
  const currentIds = new Set(groups.map((g) => g.id));
  for (const docRel of Object.keys(docIndex)) {
    const id = path.posix.basename(docRel).replace(/\.md$/, '');
    if (!currentIds.has(id)) removedModules.push({ id, doc_path: docRel });
  }

  const addedModules = [];
  for (const g of groups) {
    const relDoc = path.posix.join('modules', g.id + '.md');
    if (!Object.prototype.hasOwnProperty.call(docIndex, relDoc)) {
      const facts = buildModuleFacts(g, projectRoot);
      addedModules.push({
        id: g.id,
        directory: g.directory,
        doc_path: relDoc,
        facts,
      });
      const absDoc = moduleDocPath(projectRoot, g.id);
      if (!fs.existsSync(absDoc)) {
        fs.mkdirSync(path.dirname(absDoc), { recursive: true });
        atomicWriteFileSync(absDoc, renderModuleDoc(facts, null, hashLookup));
      }
    }
  }

  const newDocIndex = buildDocIndexMap(groups);
  const indexMapPath = path.join(projectRoot, '.nubos-pilot', 'codebase', '.doc-index.json');
  fs.mkdirSync(path.dirname(indexMapPath), { recursive: true });
  atomicWriteFileSync(indexMapPath, JSON.stringify(newDocIndex, null, 2) + '\n');

  const indexPath = indexDocPath(projectRoot);
  atomicWriteFileSync(indexPath, buildIndexDoc(groups, {}));

  writeManifest(projectRoot, next);

  stdout.write(JSON.stringify({
    mode: 'plan',
    diff_summary: diff.summary,
    touched_paths: staleInfo.touched_paths,
    stale_modules: staleModules,
    added_modules: addedModules,
    removed_modules: removedModules,
  }, null, 2));
}

function _applyProse(projectRoot, flags, stdout) {
  if (!flags.moduleId) {
    throw new NubosPilotError('update-docs-missing-module', '--apply-prose requires --module <id>', {});
  }
  if (!flags.proseFile) {
    throw new NubosPilotError('update-docs-missing-prose', '--apply-prose requires --prose-file <path>', {});
  }
  let prose;
  try {
    prose = JSON.parse(fs.readFileSync(flags.proseFile, 'utf-8'));
  } catch (err) {
    throw new NubosPilotError(
      'update-docs-prose-unreadable',
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
      'update-docs-module-not-found',
      `module not found: ${flags.moduleId}`,
      { moduleId: flags.moduleId },
    );
  }

  const facts = buildModuleFacts(target, projectRoot);
  const manifest = manifestFromScanFiles(scanResult.files);
  const hashLookup = _hashesLookupFromManifest(manifest);

  const docPath = moduleDocPath(projectRoot, target.id);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  atomicWriteFileSync(docPath, renderModuleDoc(facts, prose, hashLookup));

  writeManifest(projectRoot, manifest);

  stdout.write(JSON.stringify({
    mode: 'apply-prose',
    module_id: target.id,
    doc_path: path.relative(projectRoot, docPath),
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
      'update-docs-not-initialized',
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

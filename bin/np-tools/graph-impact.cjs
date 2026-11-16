const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const g = require('../../lib/codebase-graph.cjs');

function _parseArgs(args) {
  const flags = { cwd: null, module: null, filePath: null, cycles: false };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (a === '--cwd') flags.cwd = args[++i];
    else if (a === '--module') flags.module = args[++i];
    else if (a === '--path') flags.filePath = args[++i];
    else if (a === '--cycles') flags.cycles = true;
  }
  return flags;
}

function _graphPath(projectRoot) {
  return path.join(projectRoot, '.nubos-pilot', 'codebase', '.graph.json');
}

function _load(projectRoot) {
  const p = _graphPath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    throw new NubosPilotError(
      'graph-not-found',
      'module graph not found — run np:scan-codebase first',
      { path: '.nubos-pilot/codebase/.graph.json' },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'graph-unreadable',
      'module graph is not valid JSON — re-run np:scan-codebase',
      { path: '.nubos-pilot/codebase/.graph.json', cause: err && err.message },
    );
  }
}

function _moduleForPath(graph, rel) {
  const norm = rel.split(path.sep).join('/');
  const dir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
  const node = (graph.nodes || []).find((n) => n.directory === dir);
  return node ? node.id : null;
}

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const flags = _parseArgs(args);
  const projectRoot = path.resolve(flags.cwd || context.cwd || process.cwd());
  const graph = _load(projectRoot);

  if (flags.cycles && !flags.module && !flags.filePath) {
    stdout.write(JSON.stringify({
      module_count: graph.module_count,
      cycle_count: (graph.cycles || []).length,
      cycles: graph.cycles || [],
    }, null, 2));
    return 0;
  }

  let moduleId = flags.module;
  if (!moduleId && flags.filePath) {
    moduleId = _moduleForPath(graph, flags.filePath);
    if (!moduleId) {
      throw new NubosPilotError(
        'graph-path-unmapped',
        'no module owns that path: ' + flags.filePath,
        { path: flags.filePath },
      );
    }
  }
  if (!moduleId) {
    throw new NubosPilotError(
      'graph-missing-target',
      '--module <id> or --path <relpath> required',
      {},
    );
  }
  if (!(graph.nodes || []).some((n) => n.id === moduleId)) {
    throw new NubosPilotError(
      'graph-unknown-module',
      'module not in graph: ' + moduleId,
      { module: moduleId },
    );
  }

  stdout.write(JSON.stringify({
    module: moduleId,
    direct_dependents: g.directDependents(graph, moduleId),
    impact: g.transitiveDependents(graph, moduleId),
    direct_dependencies: g.directDependencies(graph, moduleId),
    transitive_dependencies: g.transitiveDependencies(graph, moduleId),
    cluster: g.clusterOf(graph, moduleId),
    in_cycle: g.cycleFor(graph, moduleId),
  }, null, 2));
  return 0;
}

module.exports = { run, _parseArgs };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)) || 0);
}

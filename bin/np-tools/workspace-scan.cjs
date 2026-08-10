'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { scan } = require('../../lib/workspace-scan.cjs');

function _parseArgs(args) {
  const out = { batchSize: 1000, summary: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--batch-size' || a === '-b') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new NubosPilotError('workspace-scan-invalid-batch-size',
          '--batch-size must be a positive integer', { raw: args[i] });
      }
      out.batchSize = n;
      continue;
    }
    if (a === '--summary' || a === '-s') { out.summary = true; continue; }
  }
  return out;
}

function _projectSummary(r) {
  const readmeHead = r.docs && r.docs['README.md']
    ? r.docs['README.md'].content.split('\n').slice(0, 20).join('\n')
    : null;
  return {
    file_count: r.stats.file_count,
    langs: r.language_distribution,
    manifests: Object.keys(r.manifests),
    docs: Object.keys(r.docs),
    readme_head: readmeHead,
    git: r.git,
  };
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  const result = scan({ cwd, batchSize: parsed.batchSize });
  const payload = parsed.summary ? _projectSummary(result) : result;
  stdout.write(JSON.stringify(payload));
  return 0;
}

module.exports = { run, _parseArgs, _projectSummary };

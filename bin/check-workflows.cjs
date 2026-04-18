#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const BARE_ASKUSER_RE = /AskUserQuestion/;
const DIRECT_READ_RE = /(cat\s+\.nubos-pilot|readFileSync\s*\(\s*['"][^'"]*\.nubos-pilot|\bRead\s*\(\s*['"][^'"]*\.nubos-pilot)/;

const BARE_READLINE_RE = /readline\.createInterface/;

const ALLOW_RE = /\$?\(?\s*node\s+np-tools\.cjs\s+\w+/;

const SPAWN_SITE_RE = /(Task\s*\(|Spawn\s+agent=)/;
const METRICS_RECORD_RE = /np-tools\.cjs\s+metrics\s+record\b/;
const METRICS_COVERAGE_WINDOW = 30;

const INSTALL_SCRIPT = 'bin/install.js';
const LIB_INSTALL_DIR = 'lib/install/';
const INSTALLER_SCAN_PATHS = [INSTALL_SCRIPT, LIB_INSTALL_DIR];

function _walk(dir, acc, opts) {
  const extFilter = (opts && opts.ext) || ['.md'];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return acc;
    throw err;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) _walk(abs, acc, opts);
    else if (e.isFile() && extFilter.some((x) => e.name.endsWith(x))) acc.push(abs);
  }
  return acc;
}

function _scanFiles(files) {
  const out = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const isCode = file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ALLOW_RE.test(line)) continue;
      if (BARE_ASKUSER_RE.test(line)) {
        out.push({ file, line: i + 1, pattern: 'AskUserQuestion' });
      }
      if (!isCode && DIRECT_READ_RE.test(line)) {
        out.push({ file, line: i + 1, pattern: 'direct-read .nubos-pilot' });
      }
      if (isCode && BARE_READLINE_RE.test(line)) {
        out.push({ file, line: i + 1, pattern: 'readline.createInterface' });
      }
    }
  }
  return out;
}

function _scanMetricsCoverage(files) {
  const warnings = [];
  const FENCE_RE = /^```/;
  const BASH_FENCE_RE = /^```(\s*$|\s*(bash|sh|shell|zsh)\b)/i;
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split(/\r?\n/);

    

    let inAnyFence = false;
    let inBashFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FENCE_RE.test(line)) {
        if (inAnyFence) {
          inAnyFence = false;
          inBashFence = false;
        } else {
          inAnyFence = true;
          inBashFence = BASH_FENCE_RE.test(line);
        }
        continue;
      }
      if (!inBashFence) continue;
      if (!SPAWN_SITE_RE.test(line)) continue;
      const windowEnd = Math.min(lines.length, i + 1 + METRICS_COVERAGE_WINDOW);
      const windowBody = lines.slice(i, windowEnd).join('\n');
      if (!METRICS_RECORD_RE.test(windowBody)) {
        warnings.push({
          file,
          line: i + 1,
          pattern: 'workflow-missing-metrics',
          message:
            'Task/Spawn site without `np-tools.cjs metrics record` within ' +
            METRICS_COVERAGE_WINDOW +
            ' lines (D-06).',
        });
      }
    }
  }
  return warnings;
}

function _scan(dir) {
  return _scanFiles(_walk(dir, [], { ext: ['.md'] }));
}

function _scanInstallerSurface(cwd) {
  const root = cwd || process.cwd();
  const files = [];
  for (const rel of INSTALLER_SCAN_PATHS) {
    const abs = path.resolve(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) files.push(abs);
    else if (st.isDirectory()) _walk(abs, files, { ext: ['.js', '.cjs', '.mjs'] });
  }
  return _scanFiles(files);
}

function checkWorkflows(dir) {
  const target = dir || 'nubos-pilot/workflows';
  const violations = [];
  const warnings = [];
  let workflowFiles = [];
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      workflowFiles = _walk(target, [], { ext: ['.md'] });
      violations.push(..._scanFiles(workflowFiles));
      warnings.push(..._scanMetricsCoverage(workflowFiles));
    }
  } catch {  }
  violations.push(..._scanInstallerSurface());
  return { violations, warnings, exitCode: violations.length ? 1 : 0 };
}

function main() {
  const dir = process.argv[2] || 'nubos-pilot/workflows';
  const { violations, warnings, exitCode } = checkWorkflows(dir);
  if (violations.length) {
    process.stderr.write('check-workflows: ' + violations.length + ' violation(s)\n');
    for (const v of violations) {
      process.stderr.write('  ' + v.file + ':' + v.line + ' -> ' + v.pattern + '\n');
    }
  }
  if (warnings && warnings.length) {
    process.stderr.write('check-workflows: ' + warnings.length + ' warning(s)\n');
    for (const w of warnings) {
      process.stderr.write('  ' + w.file + ':' + w.line + ' -> ' + w.pattern + '\n');
    }
  }
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = {
  checkWorkflows,
  _scan,
  _scanFiles,
  _scanInstallerSurface,
  _scanMetricsCoverage,
  INSTALL_SCRIPT,
  LIB_INSTALL_DIR,
  INSTALLER_SCAN_PATHS,
  SPAWN_SITE_RE,
  METRICS_RECORD_RE,
  METRICS_COVERAGE_WINDOW,
};

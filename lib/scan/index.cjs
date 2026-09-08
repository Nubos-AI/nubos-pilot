'use strict';

const finding = require('./finding.cjs');
const walk = require('./walk.cjs');
const inventoryMod = require('./inventory/index.cjs');
const advisoryMod = require('./advisory/index.cjs');
const licenseMod = require('./license/index.cjs');
const secretsMod = require('./secrets/scan.cjs');
const sbom = require('./sbom/export.cjs');

const MISCONFIG_CHECKERS = Object.freeze([
  require('./misconfig/ci-workflow.cjs'),
  require('./misconfig/k8s.cjs'),
  require('./misconfig/compose.cjs'),
  require('./misconfig/containerfile.cjs'),
  require('./misconfig/hcl/rules.cjs'),
]);

const SCANNERS = Object.freeze(['advisory', 'malicious', 'secrets', 'misconfig', 'license']);

const DEFAULTS = Object.freeze({
  enabled: true,
  advisory: true,
  malicious: true,
  secrets: true,
  misconfig: true,
  license: false,
  min_severity: 'high',
  ignore_scopes: Object.freeze(['dev']),
  max_findings_per_run: 50,
});

function resolveOptions(config) {
  const scan = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = scan[key] === undefined ? DEFAULTS[key] : scan[key];
  }
  out.ignore_scopes = Array.isArray(out.ignore_scopes) ? out.ignore_scopes : [];
  out.min_severity = finding.normalizeSeverity(out.min_severity);
  return out;
}

function misconfigCheckersFor(relPath) {
  const out = [];
  for (const checker of MISCONFIG_CHECKERS) {
    try { if (checker.matches(relPath)) out.push(checker); }
    catch {}
  }
  return out;
}

const CONTENT_PRECHECK = Object.freeze([
  { checker: require('./misconfig/k8s.cjs'), re: /^\s*apiVersion\s*:/m, also: /^\s*kind\s*:/m },
  { checker: require('./misconfig/compose.cjs'), re: /^\s*services\s*:/m },
]);

function _contentPlausible(checker, content) {
  const entry = CONTENT_PRECHECK.find((e) => e.checker === checker);
  if (!entry) return true;
  const text = typeof content === 'string' ? content : '';
  if (!entry.re.test(text)) return false;
  return entry.also ? entry.also.test(text) : true;
}

function scanFileContent(relPath, content, opts) {
  const o = resolveOptions(opts && opts.config);
  if (o.enabled === false) return { findings: [], warnings: [] };
  const findings = [];
  const warnings = [];

  if (o.secrets) {
    try {
      const result = secretsMod.scanContent({ filePath: relPath, content });
      findings.push(...(result.findings || []));
      for (const w of result.warnings || []) warnings.push(w);
    } catch (err) { warnings.push('secrets-scanner-failed'); }
  }

  if (o.misconfig) {
    for (const checker of misconfigCheckersFor(relPath)) {
      if (!_contentPlausible(checker, content)) continue;
      try {
        const result = checker.check(content, { file: relPath });
        findings.push(...(result.findings || []));
        for (const w of result.warnings || []) warnings.push(w);
      } catch { warnings.push('misconfig-checker-failed'); }
    }
  }

  return { findings, warnings: [...new Set(warnings)] };
}

function isManifestPath(relPath) {
  return inventoryMod.parserFor(relPath) !== null;
}

function isScannablePath(relPath, opts) {
  const o = resolveOptions(opts && opts.config);
  if (o.misconfig && misconfigCheckersFor(relPath).length) return true;
  if ((o.advisory || o.malicious || o.license) && isManifestPath(relPath)) return true;
  return !!o.secrets;
}

function scanProject(root, opts) {
  const o = resolveOptions(opts && opts.config);
  const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
  if (o.enabled === false) {
    return {
      findings: [], truncated: false, total_findings: 0, gating_findings: 0, max_severity: null,
      envelope: { allow: true, denials: [] }, warnings: [],
      report: { root, scanners: [], inventory: null, coverage: null, stats: {}, disabled: true },
      options: o,
    };
  }
  const findings = [];
  const warnings = [];
  const report = { root, scanners: [], inventory: null, coverage: null, stats: {} };

  let inventory = null;
  if (o.advisory || o.malicious || o.license) {
    inventory = inventoryMod.collect(root, opts || {});
    report.inventory = {
      packages: inventory.counts.total,
      ecosystems: inventory.ecosystems,
      files: inventory.files.map((f) => f.file),
      counts: inventory.counts,
    };
    for (const w of inventory.warnings) warnings.push(w);
  }

  if ((o.advisory || o.malicious) && inventory) {
    report.scanners.push('advisory');
    const gated = { packages: inventoryMod.gatable(inventory.packages, o.ignore_scopes) };
    const result = advisoryMod.scanInventory(gated, Object.assign({}, opts, { now }));
    report.coverage = result.coverage;
    for (const f of result.findings) {
      if (f.scanner === 'malicious' && !o.malicious) continue;
      if (f.scanner === 'advisory' && !o.advisory && f.id === advisoryMod.RULES.VULNERABILITY.id) continue;
      findings.push(f);
    }
  }

  if (o.license && inventory) {
    report.scanners.push('license');
    try {
      const policy = Object.assign({}, licenseMod.DEFAULT_POLICY, { ignoreScopes: o.ignore_scopes });
      const result = licenseMod.checkInventory(inventory, policy);
      findings.push(...(result.findings || []));
      report.license_summary = result.summary || null;
    } catch { warnings.push('license-scanner-failed'); }
  }

  if (o.secrets || o.misconfig) {
    if (o.secrets) report.scanners.push('secrets');
    if (o.misconfig) report.scanners.push('misconfig');
    const walked = walk.walk(root, [_fileExtractor(o, findings, warnings)], {
      exclude: [...walk.DEFAULT_DIR_EXCLUDES, ...walk.DEFAULT_GENERATED_EXCLUDES],
    });
    report.stats.files_visited = walked.stats.filesVisited;
    report.stats.lines_scanned = walked.stats.linesScanned;
    for (const w of walked.warnings || []) {
      warnings.push(typeof w === 'string' ? w : (w && w.code) || 'walk-warning');
    }
  }

  const sorted = finding.sortFindings(findings);
  const gating = sorted.filter((f) => finding.atLeast(f.severity, o.min_severity));
  const capped = sorted.slice(0, Math.max(0, o.max_findings_per_run));

  return {
    findings: capped,
    truncated: sorted.length > capped.length,
    total_findings: sorted.length,
    gating_findings: gating.length,
    max_severity: sorted.length ? sorted[0].severity : null,
    envelope: finding.envelope(sorted, { minSeverity: o.min_severity }),
    warnings: [...new Set(warnings)],
    report,
    options: o,
  };
}

function _fileExtractor(options, findings, warnings) {
  let lines = [];
  return {
    name: 'scan',
    onFile: () => { lines = []; return null; },
    onLine: (line) => { lines.push(line); return null; },
    onFileEnd: (ctx) => {
      const result = scanFileContent(ctx.relPath, lines.join('\n'), { config: options });
      for (const w of result.warnings) warnings.push(w);
      findings.push(...result.findings);
      return null;
    },
  };
}

function sbomFor(root, opts) {
  const o = opts || {};
  const inventory = inventoryMod.collect(root, o);
  return {
    inventory,
    bom: sbom.toCycloneDx(inventory, {
      timestamp: o.timestamp,
      projectName: o.projectName,
      projectVersion: o.projectVersion,
      toolVersion: o.toolVersion,
    }),
  };
}

module.exports = {
  SCANNERS,
  DEFAULTS,
  MISCONFIG_CHECKERS,
  resolveOptions,
  misconfigCheckersFor,
  isManifestPath,
  isScannablePath,
  scanFileContent,
  scanProject,
  sbomFor,
};

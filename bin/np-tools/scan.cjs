'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NubosPilotError, findProjectRoot } = require('../../lib/core.cjs');
const config = require('../../lib/config.cjs');
const { DEFAULT_SECURITY } = require('../../lib/config-defaults.cjs');
const scanLib = require('../../lib/scan/index.cjs');
const inventoryMod = require('../../lib/scan/inventory/index.cjs');
const advisoryDb = require('../../lib/scan/advisory/db.cjs');
const finding = require('../../lib/scan/finding.cjs');

const VERBS = Object.freeze([
  'all', 'inventory', 'advisory', 'secrets', 'misconfig', 'license', 'sbom', 'db-status',
]);

const SCANNER_FOR_VERB = Object.freeze({
  advisory: ['advisory', 'malicious'],
  secrets: ['secrets'],
  misconfig: ['misconfig'],
  license: ['license'],
});

const VALID_MIN_SEVERITY = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
const VALID_FAIL_ON = Object.freeze(['never', 'high', 'critical']);

function _assertChoice(flag, value, valid) {
  if (!valid.includes(value)) {
    throw new NubosPilotError(
      'scan-invalid-flag',
      flag + ' must be one of ' + valid.join('|') + ' (got: ' + JSON.stringify(value) + ')',
      { flag, value, valid },
    );
  }
  return value;
}

function _flags(argv) {
  const out = { json: false, root: null, minSeverity: null, failOn: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--min-severity') out.minSeverity = _assertChoice('--min-severity', argv[++i], VALID_MIN_SEVERITY);
    else if (a === '--fail-on') out.failOn = _assertChoice('--fail-on', argv[++i], VALID_FAIL_ON);
  }
  return out;
}

function _scanConfig(cwd) {
  let security;
  try { security = config.tryReadConfigPath(cwd, 'security', DEFAULT_SECURITY) || DEFAULT_SECURITY; }
  catch { security = DEFAULT_SECURITY; }
  const scan = security.scan && typeof security.scan === 'object' ? security.scan : {};
  return { security, scan };
}

function _onlyScanners(base, names) {
  const out = Object.assign({}, base);
  for (const key of scanLib.SCANNERS) out[key] = false;
  for (const key of names) out[key] = true;
  return out;
}

function _isProjectRoot(dir) {
  try { return fs.statSync(path.join(dir, '.nubos-pilot')).isDirectory(); }
  catch { return false; }
}

function _isScannable(dir) {
  const resolved = path.resolve(dir);
  return resolved !== path.parse(resolved).root && resolved !== os.homedir();
}

function _assertScannable(dir) {
  const resolved = path.resolve(dir);
  if (!_isScannable(resolved)) {
    throw new NubosPilotError(
      'scan-refused-root',
      'refusing to scan ' + resolved + ' — a home or filesystem root is never a scan target',
      { root: resolved },
    );
  }
  return resolved;
}

function _resolveRoot(cwd, flagRoot) {
  if (flagRoot) return _assertScannable(path.resolve(cwd, flagRoot));
  const here = path.resolve(cwd);
  if (_isProjectRoot(here) && _isScannable(here)) return here;
  let candidate = null;
  try { candidate = findProjectRoot(cwd); }
  catch { candidate = null; }
  if (candidate && _isProjectRoot(candidate) && _isScannable(candidate)) return candidate;
  return _assertScannable(here);
}

function _emit(stdout, payload, json) {
  if (json) {
    stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  stdout.write(_renderText(payload));
}

function _renderText(payload) {
  const lines = [];
  if (payload.verb === 'db-status') {
    lines.push('advisory database: ' + (payload.present ? 'present' : 'absent'));
    if (payload.dir) lines.push('  dir:          ' + payload.dir);
    if (payload.generated_at) lines.push('  generated_at: ' + payload.generated_at);
    if (payload.age_days != null) lines.push('  age_days:     ' + payload.age_days);
    if (payload.ecosystems) lines.push('  ecosystems:   ' + Object.keys(payload.ecosystems).join(', '));
    if (payload.integrity) {
      lines.push('  integrity:    ' + (payload.integrity.ok ? 'ok' : 'FAILED'));
      for (const f of payload.integrity.mismatches || []) lines.push('    tampered: ' + f);
      for (const f of payload.integrity.missing || []) lines.push('    missing:  ' + f);
    }
    return lines.join('\n') + '\n';
  }

  if (payload.verb === 'inventory') {
    lines.push('inventory: ' + payload.counts.total + ' packages across ' + payload.ecosystems.length + ' ecosystem(s)');
    for (const eco of payload.ecosystems) lines.push('  ' + eco + ': ' + payload.counts.by_ecosystem[eco]);
    lines.push('  scopes: ' + Object.entries(payload.counts.by_scope).map(([k, v]) => k + '=' + v).join(' '));
    for (const f of payload.files) lines.push('  from: ' + f);
    if (payload.warnings.length) lines.push('  warnings: ' + payload.warnings.join(', '));
    return lines.join('\n') + '\n';
  }

  if (payload.verb === 'sbom') return JSON.stringify(payload.bom, null, 2) + '\n';

  lines.push('scan(' + payload.verb + '): ' + payload.total_findings + ' finding(s)'
    + (payload.truncated ? ' (showing ' + payload.findings.length + ')' : '')
    + ', ' + payload.gating_findings + ' at or above ' + payload.options.min_severity);
  for (const f of payload.findings) {
    const where = f.file ? f.file + (f.line ? ':' + f.line : '') : '-';
    const pkg = f.package ? ' [' + f.package.name + (f.package.version ? '@' + f.package.version : '') + ']' : '';
    lines.push('  ' + f.severity.toUpperCase().padEnd(9) + f.id + '  ' + where + pkg);
    lines.push('           ' + (f.title || f.rule_name));
    if (f.fixed_version) lines.push('           fixed in ' + f.fixed_version);
  }
  if (payload.report && payload.report.coverage) {
    const c = payload.report.coverage;
    lines.push('coverage: db=' + (c.db_present ? 'present' : 'ABSENT')
      + (c.age_days != null ? ' age=' + c.age_days + 'd' : '')
      + (c.stale ? ' STALE' : '')
      + ' checked=' + c.packages_checked + '/' + c.packages_total);
    if (c.ecosystems_unsupported.length) lines.push('  unsupported ecosystems: ' + c.ecosystems_unsupported.join(', '));
    if (c.ecosystems_without_shard.length) lines.push('  no advisory data: ' + c.ecosystems_without_shard.join(', '));
  }
  if (payload.warnings.length) lines.push('warnings: ' + payload.warnings.join(', '));
  return lines.join('\n') + '\n';
}

function _exitCode(payload, failOn) {
  const mode = failOn || 'never';
  if (mode === 'never') return 0;
  const threshold = mode === 'critical' ? 'critical' : 'high';
  if (payload.max_severity) {
    return finding.atLeast(payload.max_severity, threshold) ? 1 : 0;
  }
  const hit = (payload.findings || []).some((f) => finding.atLeast(f.severity, threshold));
  return hit ? 1 : 0;
}

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const args = argv || [];
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write('np-tools scan <' + VERBS.join('|') + '> [--json] [--root <dir>] '
      + '[--min-severity info|low|medium|high|critical] [--fail-on never|high|critical]\n');
    return 0;
  }
  const verb = args[0] && !args[0].startsWith('--') ? args[0] : 'all';

  if (!VERBS.includes(verb)) {
    throw new NubosPilotError(
      'scan-unknown-verb',
      'unknown scan verb: ' + verb,
      { verb, valid: VERBS },
    );
  }

  const flags = _flags(args);
  const root = _resolveRoot(cwd, flags.root);
  const { scan: scanCfg } = _scanConfig(root);
  const now = Date.now();

  let base = Object.assign({}, scanLib.DEFAULTS, scanCfg);
  if (flags.minSeverity) base.min_severity = flags.minSeverity;
  if (SCANNER_FOR_VERB[verb]) base = _onlyScanners(base, SCANNER_FOR_VERB[verb]);

  if (verb === 'db-status') {
    const status = advisoryDb.status({ dir: scanCfg.db_dir || undefined, now });
    _emit(stdout, Object.assign({ verb }, status), flags.json);
    return 0;
  }

  if (verb === 'inventory') {
    const inventory = inventoryMod.collect(root, {});
    _emit(stdout, {
      verb,
      root,
      counts: inventory.counts,
      ecosystems: inventory.ecosystems,
      files: inventory.files.map((f) => f.file),
      warnings: inventory.warnings,
      packages: flags.json ? inventory.packages : undefined,
    }, flags.json);
    return 0;
  }

  if (verb === 'sbom') {
    const { bom, inventory } = scanLib.sbomFor(root, {
      timestamp: new Date(now).toISOString(),
      projectName: path.basename(root),
      toolVersion: require('../../package.json').version,
    });
    _emit(stdout, { verb, bom, packages: inventory.counts.total }, true);
    return 0;
  }

  const result = scanLib.scanProject(root, {
    config: base,
    now,
    dir: scanCfg.db_dir || undefined,
  });
  _emit(stdout, Object.assign({ verb }, result), flags.json);
  return _exitCode(result, flags.failOn || scanCfg.fail_on);
}

module.exports = { run, VERBS, SCANNER_FOR_VERB, VALID_MIN_SEVERITY, VALID_FAIL_ON, _exitCode, _renderText, _resolveRoot, _flags };

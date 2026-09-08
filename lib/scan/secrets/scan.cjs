'use strict';

const { NubosPilotError } = require('../../core.cjs');
const finding = require('../finding.cjs');
const { _globToRegExp, _looksCatastrophic } = require('../../security/scan.cjs');
const { isHighEntropy } = require('./entropy.cjs');
const { SECRET_RULES } = require('./rules.cjs');

const SCANNER = 'secrets';
const SUPPRESSION_MARKER = 'nubos-pilot:allow-secret';
const RULES_COUNT = SECRET_RULES.length;

function _countGroups(source) {
  return new RegExp(source + '|').exec('').length - 1;
}

function _fail(code, message, details) {
  throw new NubosPilotError(code, message, details);
}

function _compileGlobs(globs, ruleId) {
  const compiled = [];
  for (const glob of globs) {
    if (typeof glob !== 'string' || glob === '') {
      _fail('secrets-rule-invalid-glob', 'path globs must be non-empty strings', { rule: ruleId });
    }
    try { compiled.push(_globToRegExp(glob)); }
    catch { _fail('secrets-rule-invalid-glob', 'path glob could not be compiled', { rule: ruleId, glob }); }
  }
  return compiled;
}

function _compileRule(rule) {
  if (!rule || typeof rule !== 'object') {
    _fail('secrets-rule-not-an-object', 'every secret rule must be an object', { got: typeof rule });
  }
  if (!finding.isValidRuleId(rule.id)) {
    _fail('secrets-rule-invalid-id', 'secret rule id must match NPS-####', { id: rule.id });
  }
  if (!finding.idInRange(rule.id, SCANNER)) {
    _fail('secrets-rule-id-out-of-range', 'secret rule id must fall inside the secrets range', { id: rule.id });
  }
  if (typeof rule.rule_name !== 'string' || rule.rule_name.trim() === '') {
    _fail('secrets-rule-without-name', 'secret rule needs a non-empty rule_name', { id: rule.id });
  }

  const compiled = {
    id: rule.id,
    rule_name: rule.rule_name,
    category: typeof rule.category === 'string' && rule.category ? rule.category : 'hardcoded-secret',
    severity: finding.normalizeSeverity(rule.severity),
    cwe: Array.isArray(rule.cwe) ? rule.cwe.slice(0, 8) : [],
    reminder: typeof rule.reminder === 'string' ? rule.reminder : '',
    title: 'possible ' + rule.rule_name.replace(/_/g, ' '),
    paths: Array.isArray(rule.paths) ? _compileGlobs(rule.paths, rule.id) : null,
    exclude_paths: Array.isArray(rule.exclude_paths) ? _compileGlobs(rule.exclude_paths, rule.id) : null,
    entropy: rule.entropy && typeof rule.entropy === 'object' ? rule.entropy : null,
    regex: null,
    substrings: null,
  };

  if (typeof rule.regex === 'string' && rule.regex !== '') {
    if (_looksCatastrophic(rule.regex)) {
      _fail('secrets-rule-catastrophic-regex', 'secret rule regex is ReDoS-prone and was rejected', { id: rule.id });
    }
    try { compiled.regex = new RegExp(rule.regex); }
    catch { _fail('secrets-rule-invalid-regex', 'secret rule regex could not be compiled', { id: rule.id }); }
    if (compiled.entropy && _countGroups(rule.regex) !== 1) {
      _fail(
        'secrets-rule-entropy-without-capture',
        'an entropy-gated rule needs exactly one capture group around the candidate value',
        { id: rule.id },
      );
    }
    return compiled;
  }

  if (Array.isArray(rule.substrings) && rule.substrings.length > 0) {
    compiled.substrings = rule.substrings.filter((s) => typeof s === 'string' && s !== '');
    if (compiled.substrings.length === 0) {
      _fail('secrets-rule-empty-substrings', 'secret rule substrings must contain non-empty strings', { id: rule.id });
    }
    if (compiled.entropy) {
      _fail('secrets-rule-entropy-without-regex', 'entropy gating requires a regex matcher', { id: rule.id });
    }
    return compiled;
  }

  _fail('secrets-rule-without-matcher', 'secret rule needs a regex or substrings matcher', { id: rule.id });
}

function compileRules(rules) {
  if (!Array.isArray(rules)) {
    _fail('secrets-rules-not-an-array', 'compileRules expects an array of rules', { got: typeof rules });
  }
  const seen = new Set();
  const compiled = [];
  for (const rule of rules) {
    const one = _compileRule(rule);
    if (seen.has(one.id)) {
      _fail('secrets-rule-duplicate-id', 'secret rule ids must be unique', { id: one.id });
    }
    seen.add(one.id);
    compiled.push(one);
  }
  return compiled;
}

let _builtinCache = null;
function _builtins() {
  if (_builtinCache === null) _builtinCache = compileRules(SECRET_RULES);
  return _builtinCache;
}

function _matchesAny(candidate, regexes) {
  for (const re of regexes) {
    if (re.test(candidate)) return true;
  }
  return false;
}

function _posix(filePath) {
  return String(filePath == null ? '' : filePath).replace(/\\/g, '/');
}

function _candidate(rule, line) {
  if (rule.regex) {
    const m = rule.regex.exec(line);
    if (m === null) return null;
    return m[1] === undefined ? m[0] : m[1];
  }
  for (const s of rule.substrings) {
    if (line.includes(s)) return s;
  }
  return null;
}

function _emptyStats() {
  return {
    filesScanned: 0,
    linesScanned: 0,
    rulesEvaluated: 0,
    findings: 0,
    suppressed: 0,
    entropyPromoted: 0,
    entropyRejected: 0,
  };
}

function _newFinding(rule, filePath, line) {
  return finding.make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: SCANNER,
    source: 'builtin',
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe,
    file: filePath,
    line,
    title: rule.title,
    reminder: rule.reminder,
  });
}

function createFileScanner(compiledRules, filePath, stats) {
  const path = _posix(filePath);
  const pending = [];
  for (const rule of compiledRules) {
    if (rule.paths && !_matchesAny(path, rule.paths)) continue;
    if (rule.exclude_paths && _matchesAny(path, rule.exclude_paths)) continue;
    pending.push(rule);
  }
  stats.rulesEvaluated += pending.length;

  const hits = new Map();
  let previousLine = '';

  function feedLine(line, lineNumber) {
    stats.linesScanned++;
    const suppressed = line.includes(SUPPRESSION_MARKER) || previousLine.includes(SUPPRESSION_MARKER);
    previousLine = line;
    for (let i = pending.length - 1; i >= 0; i--) {
      const rule = pending[i];
      const candidate = _candidate(rule, line);
      if (candidate === null) continue;
      if (rule.entropy) {
        if (!isHighEntropy(candidate, { ...rule.entropy, filePath: path })) {
          stats.entropyRejected++;
          continue;
        }
        stats.entropyPromoted++;
      }
      if (suppressed) {
        stats.suppressed++;
        continue;
      }
      hits.set(rule.id, { rule, line: lineNumber });
      pending.splice(i, 1);
    }
  }

  function finish() {
    const findings = [];
    for (const hit of hits.values()) findings.push(_newFinding(hit.rule, path, hit.line));
    stats.findings += findings.length;
    return findings;
  }

  return { feedLine, finish };
}

function _splitLines(content) {
  if (content === '') return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function _gate(findings, minSeverity) {
  if (!minSeverity) return findings;
  return findings.filter((f) => finding.atLeast(f.severity, minSeverity));
}

function scanContent(opts) {
  const o = opts || {};
  const filePath = typeof o.filePath === 'string' ? o.filePath : '';
  const content = typeof o.content === 'string' ? o.content : '';
  const rules = o.rules === undefined ? _builtins() : compileRules(o.rules);
  const stats = _emptyStats();
  const scanner = createFileScanner(rules, filePath, stats);

  const lines = _splitLines(content);
  for (let i = 0; i < lines.length; i++) scanner.feedLine(lines[i], i + 1);

  stats.filesScanned = 1;
  const findings = finding.sortFindings(_gate(scanner.finish(), o.minSeverity));
  return { findings, stats };
}

function extractor(opts) {
  const o = opts || {};
  const rules = o.rules === undefined ? _builtins() : compileRules(o.rules);
  const stats = _emptyStats();
  const minSeverity = o.minSeverity;
  let current = null;

  return {
    name: typeof o.name === 'string' && o.name !== '' ? o.name : SCANNER,
    stats,
    onFile(ctx) {
      stats.filesScanned++;
      current = createFileScanner(rules, ctx.relPath, stats);
      return null;
    },
    onLine(line, lineNumber) {
      if (current !== null) current.feedLine(line, lineNumber);
      return null;
    },
    onFileEnd() {
      if (current === null) return null;
      const findings = _gate(current.finish(), minSeverity);
      current = null;
      return findings;
    },
  };
}

module.exports = {
  RULES_COUNT,
  scanContent,
  extractor,
  compileRules,
  createFileScanner,
  SUPPRESSION_MARKER,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BUILTIN_PATTERNS } = require('./patterns.cjs');
const finding = require('../scan/finding.cjs');

const MAX_CUSTOM_RULES = 50;
const MAX_REMINDER_BYTES = 1024;
const DEFAULT_SEVERITY = 'medium';
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)\s*[+*]/;

function _looksCatastrophic(src) {
  return NESTED_QUANTIFIER_RE.test(src);
}

function _globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function _pathMatchesAny(filePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const normalized = String(filePath).replace(/\\/g, '/');
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    try {
      if (_globToRegExp(g).test(normalized)) return true;
    } catch { /* skip malformed glob */ }
  }
  return false;
}

function _compileRule(rule, source) {
  if (!rule || typeof rule !== 'object') return null;
  const ruleName = typeof rule.rule_name === 'string' ? rule.rule_name.trim() : '';
  if (!ruleName) return { skipped: 'missing-rule_name' };

  let reminder = typeof rule.reminder === 'string' ? rule.reminder : '';
  if (Buffer.byteLength(reminder, 'utf-8') > MAX_REMINDER_BYTES) {
    reminder = Buffer.from(reminder, 'utf-8').slice(0, MAX_REMINDER_BYTES).toString('utf-8');
  }

  const paths = Array.isArray(rule.paths) ? rule.paths : null;
  const excludePaths = Array.isArray(rule.exclude_paths) ? rule.exclude_paths : null;

  const id = source === 'builtin' && finding.isValidRuleId(rule.id)
    ? rule.id
    : finding.customRuleId(ruleName);

  const compiled = {
    id,
    rule_name: ruleName,
    category: typeof rule.category === 'string' && rule.category ? rule.category : 'custom',
    severity: rule.severity === undefined || rule.severity === null || rule.severity === ''
      ? DEFAULT_SEVERITY
      : finding.normalizeSeverity(rule.severity),
    cwe: Array.isArray(rule.cwe) ? rule.cwe.slice(0, 8) : [],
    reminder,
    source,
    paths,
    exclude_paths: excludePaths,
    path_only: rule.path_only === true,
  };

  if (compiled.path_only) {
    if (!paths) return { skipped: 'path_only-without-paths' };
    return compiled;
  }

  if (typeof rule.regex === 'string' && rule.regex.length > 0) {
    if (_looksCatastrophic(rule.regex)) return { skipped: 'catastrophic-regex' };
    try { compiled.regex = new RegExp(rule.regex); }
    catch { return { skipped: 'invalid-regex' }; }
    return compiled;
  }

  if (Array.isArray(rule.substrings) && rule.substrings.length > 0) {
    compiled.substrings = rule.substrings.filter((s) => typeof s === 'string' && s.length > 0);
    if (compiled.substrings.length === 0) return { skipped: 'empty-substrings' };
    return compiled;
  }

  return { skipped: 'no-matcher' };
}

function loadCustomRules(customRulesPath) {
  if (!customRulesPath) return { rules: [], skipped: [] };
  let raw;
  try { raw = fs.readFileSync(customRulesPath, 'utf-8'); }
  catch { return { rules: [], skipped: [{ reason: 'unreadable', file: path.basename(String(customRulesPath)) }] }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { rules: [], skipped: [{ reason: 'invalid-json', file: path.basename(String(customRulesPath)) }] }; }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.patterns) ? parsed.patterns : null);
  if (!list) return { rules: [], skipped: [{ reason: 'no-patterns-array', file: path.basename(String(customRulesPath)) }] };

  const rules = [];
  const skipped = [];
  for (const entry of list.slice(0, MAX_CUSTOM_RULES)) {
    const c = _compileRule(entry, 'custom');
    if (c && c.skipped) { skipped.push({ reason: c.skipped, rule_name: entry && entry.rule_name }); continue; }
    if (c) rules.push(c);
  }
  if (list.length > MAX_CUSTOM_RULES) {
    skipped.push({ reason: 'rule-cap-exceeded', dropped: list.length - MAX_CUSTOM_RULES });
  }
  return { rules, skipped };
}

let _builtinCompiled = null;
function _builtins() {
  if (_builtinCompiled) return _builtinCompiled;
  _builtinCompiled = BUILTIN_PATTERNS.map((r) => _compileRule(r, 'builtin')).filter((c) => c && !c.skipped);
  return _builtinCompiled;
}

function _firstMatchLine(content, compiled) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (compiled.regex) {
      if (compiled.regex.test(line)) return i + 1;
    } else if (compiled.substrings) {
      for (const s of compiled.substrings) {
        if (line.includes(s)) return i + 1;
      }
    }
  }
  return null;
}

function _finding(rule, filePath, line) {
  return finding.make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: 'patterns',
    source: rule.source,
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe,
    file: filePath,
    line,
    title: rule.rule_name,
    reminder: rule.reminder,
  });
}

function scanContent(opts) {
  const o = opts || {};
  const filePath = o.filePath || '';
  const content = typeof o.content === 'string' ? o.content : '';
  const custom = loadCustomRules(o.customRulesPath);
  const rules = _builtins().concat(custom.rules);
  const findings = [];

  for (const rule of rules) {
    if (rule.paths && !_pathMatchesAny(filePath, rule.paths)) continue;
    if (rule.exclude_paths && _pathMatchesAny(filePath, rule.exclude_paths)) continue;

    if (rule.path_only) {
      findings.push(_finding(rule, filePath, 1));
      continue;
    }

    const line = _firstMatchLine(content, rule);
    if (line != null) {
      findings.push(_finding(rule, filePath, line));
    }
  }

  return { findings, custom_skipped: custom.skipped };
}

module.exports = {
  scanContent,
  loadCustomRules,
  _globToRegExp,
  _looksCatastrophic,
  MAX_CUSTOM_RULES,
};

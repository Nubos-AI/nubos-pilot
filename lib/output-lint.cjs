'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function _checkType(value, expected, path, violations) {
  if (expected == null) return;
  const got = _typeOf(value);
  if (expected === 'integer') {
    if (!Number.isInteger(value)) {
      violations.push({ path, code: 'type', message: 'expected integer, got ' + got });
    }
    return;
  }
  if (got !== expected) {
    violations.push({ path, code: 'type', message: 'expected ' + expected + ', got ' + got });
  }
}

function _checkEnum(value, allowed, path, violations) {
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  if (!allowed.includes(value)) {
    violations.push({
      path,
      code: 'enum',
      message: 'value ' + JSON.stringify(value) + ' not in ' + JSON.stringify(allowed),
    });
  }
}

function _checkMin(value, min, path, violations) {
  if (typeof min !== 'number' || typeof value !== 'number') return;
  if (value < min) {
    violations.push({ path, code: 'min', message: 'value ' + value + ' < ' + min });
  }
}

function _checkFrontmatter(fm, schema, violations) {
  const props = schema.properties || {};
  const required = schema.required || [];
  for (const key of required) {
    if (!(key in fm)) {
      violations.push({
        path: 'frontmatter.' + key,
        code: 'missing-required',
        message: 'required key missing',
      });
    }
  }
  for (const [key, rule] of Object.entries(props)) {
    if (!(key in fm)) continue;
    const value = fm[key];
    if (rule.type) _checkType(value, rule.type, 'frontmatter.' + key, violations);
    if (rule.enum) _checkEnum(value, rule.enum, 'frontmatter.' + key, violations);
    if (rule.minimum != null) _checkMin(value, rule.minimum, 'frontmatter.' + key, violations);
  }
}

function _evalInvariant(invariant, ctx) {
  const { lhs, op, rhs } = invariant;
  const left = _resolveExpr(lhs, ctx);
  const right = _resolveExpr(rhs, ctx);
  switch (op) {
    case '=': case '==': case '===': return left === right;
    case '!=': case '!==': return left !== right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: return false;
  }
}

function _resolveExpr(expr, ctx) {
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (typeof expr !== 'string') return null;
  if (expr.includes('+')) {
    const parts = expr.split('+').map((p) => p.trim());
    if (parts.length > 1) {
      let sum = 0;
      for (const p of parts) {
        const v = _resolveExpr(p, ctx);
        if (typeof v !== 'number') return NaN;
        sum += v;
      }
      return sum;
    }
  }
  const path = expr.split('.');
  let cur = ctx;
  for (const seg of path) {
    if (cur == null) return null;
    cur = cur[seg];
  }
  return cur;
}

function _checkInvariants(invariants, ctx, violations) {
  if (!Array.isArray(invariants)) return;
  for (const inv of invariants) {
    const ok = _evalInvariant(inv, ctx);
    if (!ok) {
      violations.push({
        path: inv.path || 'invariant',
        code: 'invariant',
        message: inv.message || (inv.lhs + ' ' + inv.op + ' ' + inv.rhs + ' (failed)'),
      });
    }
  }
}

function _checkBodyPatterns(body, patterns, violations) {
  if (!Array.isArray(patterns)) return;
  for (const p of patterns) {
    const re = new RegExp(p.pattern, p.flags || 'm');
    const matches = [...body.matchAll(new RegExp(p.pattern, (p.flags || 'm').includes('g') ? p.flags : (p.flags || '') + 'g'))];
    if (typeof p.min === 'number' && matches.length < p.min) {
      violations.push({
        path: p.path || 'body',
        code: 'body-pattern-min',
        message: (p.message || 'pattern ' + p.pattern + ' matched ' + matches.length + ' times, expected ≥ ' + p.min),
      });
    }
    if (typeof p.max === 'number' && matches.length > p.max) {
      violations.push({
        path: p.path || 'body',
        code: 'body-pattern-max',
        message: (p.message || 'pattern ' + p.pattern + ' matched ' + matches.length + ' times, expected ≤ ' + p.max),
      });
    }
    if (p.forbidden && re.test(body)) {
      violations.push({
        path: p.path || 'body',
        code: 'forbidden-pattern',
        message: p.message || 'forbidden pattern present: ' + p.pattern,
      });
    }
  }
}

function _runBlockChecks(body, schema, violations) {
  const block = schema.body && schema.body.blocks;
  if (!block) return;
  const headingRe = new RegExp(block.heading_pattern, 'gm');
  const matches = [...body.matchAll(headingRe)];
  if (typeof block.min_count === 'number' && matches.length < block.min_count) {
    violations.push({
      path: 'body.blocks',
      code: 'block-min',
      message: 'expected ≥ ' + block.min_count + ' blocks matching ' + block.heading_pattern + ', got ' + matches.length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const slice = body.slice(start, end);
    const id = m[1] || ('#' + (i + 1));
    for (const field of (block.required_fields || [])) {
      const fieldRe = new RegExp('(?:^|\\n)[*-]?\\s*\\*\\*' + field.name + ':\\*\\*\\s*([^\\n]*)');
      const fm = slice.match(fieldRe);
      if (!fm) {
        violations.push({
          path: 'body.blocks[' + id + '].' + field.name,
          code: 'block-field-missing',
          message: 'block ' + id + ' missing required field "' + field.name + '"',
        });
        continue;
      }
      const value = fm[1].trim();
      if (Array.isArray(field.enum) && field.enum.length > 0 && !field.enum.includes(value)) {
        violations.push({
          path: 'body.blocks[' + id + '].' + field.name,
          code: 'block-field-enum',
          message: 'field "' + field.name + '" in block ' + id + ': value ' + JSON.stringify(value) + ' not in ' + JSON.stringify(field.enum),
        });
      }
      if (field.forbidden_values && field.forbidden_values.includes(value)) {
        violations.push({
          path: 'body.blocks[' + id + '].' + field.name,
          code: 'block-field-forbidden',
          message: 'field "' + field.name + '" in block ' + id + ': forbidden value ' + JSON.stringify(value),
        });
      }
      if (field.forbidden_substring && value.includes(field.forbidden_substring)) {
        violations.push({
          path: 'body.blocks[' + id + '].' + field.name,
          code: 'block-field-forbidden-substring',
          message: 'field "' + field.name + '" in block ' + id + ': contains forbidden substring "' + field.forbidden_substring + '"',
        });
      }
    }
    if (block.heading_forbidden_substring && m[0].includes(block.heading_forbidden_substring)) {
      violations.push({
        path: 'body.blocks[' + id + '].heading',
        code: 'block-heading-forbidden',
        message: 'block heading contains forbidden substring "' + block.heading_forbidden_substring + '": ' + m[0].trim(),
      });
    }
  }
}

function lintContent(rawContent, schema) {
  const violations = [];
  if (typeof rawContent !== 'string') {
    return { ok: false, violations: [{ path: 'content', code: 'no-content', message: 'content is not a string' }] };
  }
  let fm = {};
  let body = rawContent;
  try {
    const parsed = extractFrontmatter(rawContent);
    fm = parsed.frontmatter || {};
    body = parsed.body || '';
  } catch (err) {
    violations.push({
      path: 'frontmatter',
      code: 'frontmatter-parse-error',
      message: 'frontmatter parse failed: ' + (err && err.message),
    });
  }

  if (schema.frontmatter) {
    _checkFrontmatter(fm, schema.frontmatter, violations);
    _checkInvariants(schema.frontmatter.invariants, { frontmatter: fm }, violations);
  }
  if (schema.body) {
    if (Array.isArray(schema.body.patterns)) _checkBodyPatterns(body, schema.body.patterns, violations);
    _runBlockChecks(body, schema, violations);
  }

  return { ok: violations.length === 0, violations, frontmatter: fm, schema_name: schema.name };
}

function lintFile(filePath, schema) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, violations: [{ path: filePath, code: 'file-missing', message: 'file does not exist' }] };
    }
    throw err;
  }
  const result = lintContent(raw, schema);
  result.path = filePath;
  return result;
}

function enforceFile(filePath, schema) {
  const result = lintFile(filePath, schema);
  if (!result.ok) {
    throw new NubosPilotError(
      'output-schema-violation',
      'Output artefact violates schema ' + (schema.name || '<unnamed>') + ' (' + result.violations.length + ' violations)',
      { schema: schema.name, file: filePath, violations: result.violations },
    );
  }
  return result;
}

function schemaPrompt(schema) {
  const lines = [];
  lines.push('# Output Schema — ' + (schema.name || '<unnamed>'));
  lines.push('');
  if (schema.description) {
    lines.push(schema.description);
    lines.push('');
  }
  if (schema.frontmatter) {
    lines.push('## Frontmatter (required block at top of file)');
    lines.push('');
    lines.push('```yaml');
    lines.push('---');
    if (Array.isArray(schema.frontmatter.required)) {
      for (const key of schema.frontmatter.required) {
        const rule = (schema.frontmatter.properties || {})[key] || {};
        let example = rule.example != null ? JSON.stringify(rule.example) : '<' + (rule.type || 'value') + '>';
        if (Array.isArray(rule.enum) && rule.enum.length > 0) example = rule.enum.join(' | ');
        lines.push(key + ': ' + example);
      }
    }
    lines.push('---');
    lines.push('```');
    if (Array.isArray(schema.frontmatter.invariants) && schema.frontmatter.invariants.length > 0) {
      lines.push('');
      lines.push('**Cross-field invariants (must hold or the artefact is rejected):**');
      for (const inv of schema.frontmatter.invariants) {
        lines.push('- ' + (inv.message || (inv.lhs + ' ' + inv.op + ' ' + inv.rhs)));
      }
    }
    lines.push('');
  }
  if (schema.body && schema.body.blocks) {
    const b = schema.body.blocks;
    lines.push('## Body blocks');
    lines.push('');
    lines.push('- Heading pattern: `' + b.heading_pattern + '`');
    if (typeof b.min_count === 'number') {
      lines.push('- Minimum count: ' + b.min_count);
    }
    if (Array.isArray(b.required_fields) && b.required_fields.length > 0) {
      lines.push('- Each block must contain these fields (markdown bold-colon style — `- **Field:** value`):');
      for (const f of b.required_fields) {
        let line = '  - `' + f.name + '`';
        if (Array.isArray(f.enum) && f.enum.length > 0) line += ' — one of: `' + f.enum.join('` | `') + '`';
        lines.push(line);
      }
    }
    if (b.heading_forbidden_substring) {
      lines.push('- Heading must NOT contain: `' + b.heading_forbidden_substring + '`');
    }
    lines.push('');
  }
  lines.push('## Hard-fail contract');
  lines.push('');
  lines.push('Any violation = workflow exits non-zero. Re-spawn the agent with the violation list as feedback; do not patch the file by hand.');
  return lines.join('\n');
}

module.exports = {
  lintContent,
  lintFile,
  enforceFile,
  schemaPrompt,
};

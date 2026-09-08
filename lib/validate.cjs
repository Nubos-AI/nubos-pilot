'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('./core.cjs');

const SCHEMA_DIR = path.join(__dirname, 'schemas', 'data');
const PATTERN_INPUT_MAX = 64 * 1024;
const _cache = new Map();

function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function _deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) _deepFreeze(obj[key]);
  }
  return obj;
}

function _deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!_deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!_hasOwn(b, key) || !_deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function _loadSchema(name) {
  if (_cache.has(name)) return _cache.get(name);
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(String(name))) {
    throw new NubosPilotError(
      'data-schema-not-found',
      'Invalid data-schema name: ' + JSON.stringify(name),
      { name },
    );
  }
  const p = path.join(SCHEMA_DIR, name + '.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (err) {
    throw new NubosPilotError(
      'data-schema-not-found',
      'Unknown data schema: ' + String(name),
      { name, cause: err && err.code, available: listSchemas() },
    );
  }
  let schema;
  try { schema = JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      'data-schema-corrupt',
      'Data schema ' + name + '.json is not valid JSON: ' + (err && err.message),
      { name },
    );
  }
  _deepFreeze(schema);
  _cache.set(name, schema);
  return schema;
}

function listSchemas() {
  let entries;
  try { entries = fs.readdirSync(SCHEMA_DIR); }
  catch { return []; }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function _typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function _matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function _segmentsToPath(segments) {
  if (!segments.length) return '';
  return '/' + segments.map((s) => String(s)).join('/');
}

function _lastNamed(segments) {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (typeof segments[i] === 'string') return segments[i];
  }
  return null;
}

function _firstIndex(segments) {
  for (const s of segments) if (typeof s === 'number') return s;
  return null;
}

function _push(errors, segments, keyword, message, extra) {
  const err = {
    instancePath: _segmentsToPath(segments),
    keyword,
    message,
    field: _lastNamed(segments),
    index: _firstIndex(segments),
  };
  if (extra) Object.assign(err, extra);
  errors.push(err);
}

function _validateNode(value, schema, segments, errors) {
  if (!schema || typeof schema !== 'object') return;

  if ('const' in schema && !_deepEqual(value, schema.const)) {
    _push(errors, segments, 'const', _label(segments) + ' must equal ' + JSON.stringify(schema.const),
      { expected: schema.const, actual: value });
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => _matchesType(value, t))) {
      _push(errors, segments, 'type',
        _label(segments) + ' must be ' + types.join(' or ') + ' (got ' + _typeOf(value) + ')',
        { expected: schema.type, actual: _typeOf(value) });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => _deepEqual(e, value))) {
    _push(errors, segments, 'enum',
      _label(segments) + ' must be one of ' + JSON.stringify(schema.enum) + ' (got ' + JSON.stringify(value) + ')',
      { expected: schema.enum, actual: value });
  }

  if (typeof value === 'string') _validateString(value, schema, segments, errors);
  if (typeof value === 'number') _validateNumber(value, schema, segments, errors);
  if (Array.isArray(value)) _validateArray(value, schema, segments, errors);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    _validateObject(value, schema, segments, errors);
  }
}

function _label(segments) {
  const named = _lastNamed(segments);
  const idx = _firstIndex(segments);
  if (named && idx !== null && segments[segments.length - 1] === named) {
    return named;
  }
  return named || (idx !== null ? '[' + idx + ']' : 'value');
}

function _validateString(value, schema, segments, errors) {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    _push(errors, segments, 'minLength',
      _label(segments) + ' must be at least ' + schema.minLength + ' characters',
      { expected: schema.minLength, actual: value.length });
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    _push(errors, segments, 'maxLength',
      _label(segments) + ' must be at most ' + schema.maxLength + ' characters',
      { expected: schema.maxLength, actual: value.length });
  }
  if (typeof schema.maxBytes === 'number') {
    const bytes = Buffer.byteLength(value, 'utf-8');
    if (bytes > schema.maxBytes) {
      _push(errors, segments, 'maxBytes',
        _label(segments) + ' exceeds ' + schema.maxBytes + ' bytes (got ' + bytes + ')',
        { expected: schema.maxBytes, actual: bytes });
    }
  }
  if (typeof schema.pattern === 'string') {
    if (value.length > PATTERN_INPUT_MAX) {
      _push(errors, segments, 'pattern',
        _label(segments) + ' is too long (' + value.length + ' chars) to match ' + schema.pattern,
        { expected: schema.pattern, actual: value.length });
    } else if (!new RegExp(schema.pattern).test(value)) {
      _push(errors, segments, 'pattern',
        _label(segments) + ' must match ' + schema.pattern,
        { expected: schema.pattern, actual: value });
    }
  }
}

function _validateNumber(value, schema, segments, errors) {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    _push(errors, segments, 'minimum',
      _label(segments) + ' must be >= ' + schema.minimum + ' (got ' + value + ')',
      { expected: schema.minimum, actual: value });
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    _push(errors, segments, 'exclusiveMinimum',
      _label(segments) + ' must be > ' + schema.exclusiveMinimum + ' (got ' + value + ')',
      { expected: schema.exclusiveMinimum, actual: value });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    _push(errors, segments, 'maximum',
      _label(segments) + ' must be <= ' + schema.maximum + ' (got ' + value + ')',
      { expected: schema.maximum, actual: value });
  }
}

function _validateArray(value, schema, segments, errors) {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    _push(errors, segments, 'minItems',
      _label(segments) + ' must have at least ' + schema.minItems + ' items',
      { expected: schema.minItems, actual: value.length });
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    _push(errors, segments, 'maxItems',
      _label(segments) + ' must have at most ' + schema.maxItems + ' items',
      { expected: schema.maxItems, actual: value.length });
  }
  if (schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      _validateNode(value[i], schema.items, segments.concat(i), errors);
    }
  }
}

function _validateObject(value, schema, segments, errors) {
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!_hasOwn(value, field) || value[field] === undefined) {
        _push(errors, segments.concat(field), 'required',
          _objLabel(segments) + ' missing required field "' + field + '"',
          { field });
      }
    }
  }
  const props = schema.properties || {};
  const addl = schema.additionalProperties;
  if (addl === false) {
    for (const key of Object.keys(value)) {
      if (!_hasOwn(props, key) && value[key] !== undefined) {
        _push(errors, segments.concat(key), 'additionalProperties',
          _objLabel(segments) + ' has unknown field "' + key + '"',
          { field: key });
      }
    }
  } else if (addl && typeof addl === 'object') {
    for (const key of Object.keys(value)) {
      if (!_hasOwn(props, key) && value[key] !== undefined) {
        _validateNode(value[key], addl, segments.concat(key), errors);
      }
    }
  }
  for (const key of Object.keys(props)) {
    if (_hasOwn(value, key) && value[key] !== undefined) {
      _validateNode(value[key], props[key], segments.concat(key), errors);
    }
  }
}

function _objLabel(segments) {
  const idx = _firstIndex(segments);
  const named = _lastNamed(segments);
  if (named) return named;
  if (idx !== null) return '[' + idx + ']';
  return 'object';
}

function validate(value, schemaName) {
  const schema = typeof schemaName === 'string' ? _loadSchema(schemaName) : schemaName;
  const errors = [];
  _validateNode(value, schema, [], errors);
  return errors;
}

function assertValid(value, schemaName, code, baseDetails) {
  const errors = validate(value, schemaName);
  if (errors.length === 0) return;
  const first = errors[0];
  throw new NubosPilotError(
    code,
    first.message,
    Object.assign({ schema: schemaName, errors }, first, baseDetails || {}),
  );
}

module.exports = { validate, assertValid, listSchemas, _loadSchema, SCHEMA_DIR };

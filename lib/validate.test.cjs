'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validate, assertValid, listSchemas, _loadSchema } = require('./validate.cjs');
const { NubosPilotError } = require('./core.cjs');
const learnings = require('./learnings.cjs');
const memory = require('./memory.cjs');
const messaging = require('./messaging.cjs');

const RECORD = {
  type: 'object',
  required: ['fingerprint', 'occurrence'],
  properties: {
    fingerprint: { type: 'string', pattern: '^[a-f0-9]{16}$' },
    occurrence: { type: 'integer', minimum: 1 },
    pattern: { type: 'string', maxBytes: 8 },
    status: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

test('VAL-1: valid object yields no errors', () => {
  assert.deepEqual(validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 3 }, RECORD), []);
});

test('VAL-2: missing required field reports field name', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa' }, RECORD);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].keyword, 'required');
  assert.equal(errs[0].field, 'occurrence');
});

test('VAL-3: type mismatch reports expected/actual', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 'x' }, RECORD);
  assert.equal(errs[0].keyword, 'type');
  assert.equal(errs[0].field, 'occurrence');
  assert.equal(errs[0].actual, 'string');
});

test('VAL-4: pattern mismatch', () => {
  const errs = validate({ fingerprint: 'NOTHEX', occurrence: 1 }, RECORD);
  assert.equal(errs[0].keyword, 'pattern');
  assert.match(errs[0].message, /fingerprint/);
});

test('VAL-5: minimum violation', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 0 }, RECORD);
  assert.equal(errs[0].keyword, 'minimum');
});

test('VAL-6: non-integer rejected by integer type', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 1.5 }, RECORD);
  assert.equal(errs[0].keyword, 'type');
});

test('VAL-7: maxBytes counts UTF-8 bytes', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 1, pattern: 'üüüüü' }, RECORD);
  assert.equal(errs[0].keyword, 'maxBytes');
  assert.equal(errs[0].actual, 10);
});

test('VAL-8: enum violation', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 1, status: 'z' }, RECORD);
  assert.equal(errs[0].keyword, 'enum');
});

test('VAL-9: nested array items validated with index in path', () => {
  const errs = validate({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 1, tags: ['ok', 5] }, RECORD);
  assert.equal(errs[0].keyword, 'type');
  assert.equal(errs[0].index, 1);
  assert.equal(errs[0].instancePath, '/tags/1');
});

test('VAL-10: assertValid throws NubosPilotError with given code and errors detail', () => {
  assert.throws(
    () => assertValid({ fingerprint: 'NOTHEX' }, RECORD, 'demo-corrupt', { path: '/tmp/x' }),
    (err) => err instanceof NubosPilotError
      && err.code === 'demo-corrupt'
      && Array.isArray(err.details.errors)
      && err.details.path === '/tmp/x',
  );
});

test('VAL-11: assertValid is a no-op when valid', () => {
  assert.doesNotThrow(() => assertValid({ fingerprint: 'aaaaaaaaaaaaaaaa', occurrence: 1 }, RECORD, 'demo-corrupt'));
});

test('VAL-12: unknown schema name throws data-schema-not-found', () => {
  assert.throws(
    () => validate({}, 'no-such-schema'),
    (err) => err instanceof NubosPilotError && err.code === 'data-schema-not-found',
  );
});

test('VAL-13: invalid schema name is rejected before fs access', () => {
  assert.throws(
    () => validate({}, '../etc/passwd'),
    (err) => err instanceof NubosPilotError && err.code === 'data-schema-not-found',
  );
});

test('VAL-14: learnings.v1 is registered and loadable', () => {
  assert.ok(listSchemas().includes('learnings.v1'));
  const schema = _loadSchema('learnings.v1');
  assert.equal(schema.$id, 'learnings.v1');
});

test('VAL-15: learnings.v1 pattern maxBytes stays in sync with MAX_PATTERN_BYTES', () => {
  const schema = _loadSchema('learnings.v1');
  const patternSchema = schema.properties.learnings.items.properties.pattern;
  assert.equal(
    patternSchema.maxBytes,
    learnings.MAX_PATTERN_BYTES,
    'learnings.v1.json pattern.maxBytes drifted from learnings.MAX_PATTERN_BYTES',
  );
});

test('VAL-16: learnings.v1 outcome maxBytes stays in sync with MAX_OUTCOME_BYTES', () => {
  const schema = _loadSchema('learnings.v1');
  const outcomeSchema = schema.properties.learnings.items.properties.outcome;
  assert.equal(
    outcomeSchema.maxBytes,
    learnings.MAX_OUTCOME_BYTES,
    'learnings.v1.json outcome.maxBytes drifted from learnings.MAX_OUTCOME_BYTES',
  );
});

test('VAL-17: additionalProperties:false flags inherited-name own keys (no prototype-chain bypass)', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
  const input = JSON.parse('{"a":"x","constructor":1,"toString":1}');
  const errs = validate(input, schema);
  const unknown = errs.filter((e) => e.keyword === 'additionalProperties').map((e) => e.field).sort();
  assert.deepEqual(unknown, ['constructor', 'toString']);
});

test('VAL-18: required is satisfied only by own properties, not Object.prototype members', () => {
  const schema = { type: 'object', required: ['toString', 'fingerprint'] };
  const errs = validate({}, schema);
  const missing = errs.filter((e) => e.keyword === 'required').map((e) => e.field).sort();
  assert.deepEqual(missing, ['fingerprint', 'toString']);
});

test('VAL-19: a property named like a prototype member does not validate the inherited value', () => {
  const schema = { type: 'object', properties: { toString: { type: 'string' } } };
  const errs = validate(JSON.parse('{"a":1}'), schema);
  assert.deepEqual(errs, []);
});

test('VAL-20: pattern does not run on pathological oversized input (ReDoS guard)', () => {
  const schema = { type: 'string', pattern: '^(a+)+$' };
  const errs = validate('a'.repeat(70000) + '!', schema);
  assert.equal(errs[0].keyword, 'pattern');
  assert.match(errs[0].message, /too long/);
});

test('VAL-21: enum/const equality is key-order independent', () => {
  const enumSchema = { enum: [{ a: 1, b: 2 }] };
  assert.deepEqual(validate(JSON.parse('{"b":2,"a":1}'), enumSchema), []);
  const constSchema = { const: { a: 1, b: 2 } };
  assert.deepEqual(validate(JSON.parse('{"b":2,"a":1}'), constSchema), []);
});

test('VAL-23: memory-record.v1 type enum stays in sync with TYPE_ENUM', () => {
  const schema = _loadSchema('memory-record.v1');
  assert.deepEqual(schema.properties.type.enum, [...memory.TYPE_ENUM]);
});

test('VAL-24: memory-record.v1 provenance enum stays in sync with PROVENANCE_ENUM', () => {
  const schema = _loadSchema('memory-record.v1');
  const nonNull = schema.properties.provenance.enum.filter((e) => e !== null);
  assert.deepEqual(nonNull, [...memory.PROVENANCE_ENUM]);
  assert.ok(schema.properties.provenance.enum.includes(null));
});

test('VAL-25: memory-manifest.v1 accepts both init and rebuilt manifests', () => {
  assert.deepEqual(validate({ schema_version: 1, model: 'm', dim: 384, alpha: 0.6, created_at: 'x' }, 'memory-manifest.v1'), []);
  assert.deepEqual(validate({ schema_version: 1, model: 'm', dim: 384, alpha: 0.6, rebuilt_at: 'x' }, 'memory-manifest.v1'), []);
  assert.equal(validate({ schema_version: 1, model: 'm' }, 'memory-manifest.v1').length, 1);
});

test('VAL-26: additionalProperties as a schema validates every map value', () => {
  const schema = { type: 'object', additionalProperties: { type: 'object', required: ['sha256'], properties: { sha256: { type: 'string' } } } };
  assert.deepEqual(validate({ 'a.js': { sha256: 'x' }, 'b.js': { sha256: 'y' } }, schema), []);
  const errs = validate({ 'a.js': { sha256: 'x' }, 'b.js': { size: 5 } }, schema);
  assert.equal(errs[0].keyword, 'required');
  assert.equal(errs[0].field, 'sha256');
  assert.equal(errs[0].instancePath, '/b.js/sha256');
});

test('VAL-27: codebase-manifest.v1 rejects a file entry missing sha256', () => {
  const errs = validate({ schema_version: 1, files: { 'a.js': { size: 10, ext: '.js' } } }, 'codebase-manifest.v1');
  assert.equal(errs[0].keyword, 'required');
  assert.equal(errs[0].field, 'sha256');
});

test('VAL-28: message.v1 id/from/to patterns stay in sync with messaging regexes', () => {
  const schema = _loadSchema('message.v1');
  assert.equal(schema.properties.id.pattern, messaging.ID_RE.source);
  assert.equal(schema.properties.from.pattern, messaging.AGENT_RE.source);
  assert.equal(schema.properties.to.pattern, messaging.AGENT_RE.source);
});

test('VAL-29: message.v1 body maxBytes stays in sync with MAX_BODY_BYTES', () => {
  const schema = _loadSchema('message.v1');
  assert.equal(schema.properties.body.maxBytes, messaging.MAX_BODY_BYTES);
});

test('VAL-32: message.v1 kind enum stays in sync with KIND_ENUM', () => {
  const schema = _loadSchema('message.v1');
  assert.deepEqual(schema.properties.kind.enum, [...messaging.KIND_ENUM]);
});

test('VAL-30: metrics-record.v1 accepts coexisting record shapes (buildRecord + session-aggregate)', () => {
  const buildShape = {
    agent: 'a', tier: 't', resolved_model: 'm', phase: '10', plan: 'p', task: 'k',
    started_at: 'x', ended_at: 'y', duration_ms: 1000, tokens_in: 100, tokens_out: 50,
    retry_count: 0, status: 'ok', runtime: 'claude', error: null,
  };
  const sessionShape = {
    schema_version: 2, started_at: 'x', phase: 'P1', agent: 'a', tier: 't', resolved_model: 'm',
    plan: 'PL1', task: 'TA1', tokens_in: 10, tokens_out: 20, duration_ms: 100, status: 'ok',
    runtime: 'claude', retry_count: 0,
  };
  assert.deepEqual(validate(buildShape, 'metrics-record.v1'), []);
  assert.deepEqual(validate(sessionShape, 'metrics-record.v1'), []);
});

test('VAL-31: metrics-record.v1 rejects a record whose arithmetic field is the wrong type', () => {
  const errs = validate({ agent: 'a', tokens_in: 'not-a-number' }, 'metrics-record.v1');
  assert.equal(errs[0].keyword, 'type');
  assert.equal(errs[0].field, 'tokens_in');
});

test('VAL-22: circular / non-serializable input does not throw a raw TypeError', () => {
  const circular = { a: 1 };
  circular.self = circular;
  let errs;
  assert.doesNotThrow(() => { errs = validate(circular, { const: { a: 1 } }); });
  assert.equal(errs[0].keyword, 'const');
});

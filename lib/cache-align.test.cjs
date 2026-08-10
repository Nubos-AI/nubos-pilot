'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ca = require('./cache-align.cjs');

test('CA-1: detectVolatile flags UUID/ISO-date/JWT/hex in the system prompt', () => {
  const sys = 'Run id 550e8400-e29b-41d4-a716-446655440000 at 2026-06-23T10:00:00Z '
    + 'token eyJhbGc.eyJzdWI.sig hash d41d8cd98f00b204e9800998ecf8427e';
  const kinds = ca.detectVolatile(sys).map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['hex_hash', 'iso_datetime', 'jwt', 'uuid']);
});

test('CA-2: detectVolatile reads an array-form system prompt and is clean when stable', () => {
  assert.deepEqual(ca.detectVolatile([{ type: 'text', text: 'You are a stable agent.' }]), []);
  assert.deepEqual(ca.detectVolatile('plain stable instructions'), []);
});

test('CA-3: normalizeTools sorts tools by name and recursively sorts schema keys; arrays keep order', () => {
  const tools = [
    { name: 'zeta', description: 'z', input_schema: { type: 'object', required: ['b', 'a'], properties: { y: {}, x: {} } } },
    { name: 'alpha', description: 'a', input_schema: { properties: { n: {} }, type: 'object' } },
  ];
  const out = ca.normalizeTools(tools);
  assert.deepEqual(out.map((t) => t.name), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(out[1]), ['description', 'input_schema', 'name']);
  assert.deepEqual(Object.keys(out[1].input_schema.properties), ['x', 'y']);
  assert.deepEqual(out[1].input_schema.required, ['b', 'a']);
});

test('CA-4: alignAnthropicBody adds exactly one ephemeral breakpoint on the last tool and is idempotent', () => {
  const body = { system: 'sys', tools: [{ name: 'b' }, { name: 'a' }], messages: [] };
  const r1 = ca.alignAnthropicBody(body);
  assert.equal(r1.applied, true);
  assert.deepEqual(r1.body.tools.map((t) => t.name), ['a', 'b']);
  assert.equal(r1.body.tools[0].cache_control, undefined);
  assert.deepEqual(r1.body.tools[1].cache_control, { type: 'ephemeral' });
  const r2 = ca.alignAnthropicBody(r1.body);
  assert.equal(r2.applied, false, 'second pass is a no-op — breakpoint already present');
  assert.equal(JSON.stringify(r2.body), JSON.stringify(r1.body), 'byte-identical second pass');
});

test('CA-4b: normalizeTools is byte-deterministic regardless of input order (codepoint, not locale)', () => {
  const a = [{ name: 'get_A' }, { name: 'get-a' }, { name: 'get_a' }, { name: 'tool10' }, { name: 'tool2' }];
  const b = a.slice().reverse();
  assert.equal(JSON.stringify(ca.normalizeTools(a)), JSON.stringify(ca.normalizeTools(b)), 'order-independent, stable bytes');
  assert.deepEqual(ca.normalizeTools(a).map((t) => t.name), ['get-a', 'get_A', 'get_a', 'tool10', 'tool2']);
});

test('CA-4c: duplicate/degenerate names still order deterministically via body tiebreak', () => {
  const x = [{ name: 'x', id: 2 }, { name: 'x', id: 1 }];
  assert.equal(JSON.stringify(ca.normalizeTools(x)), JSON.stringify(ca.normalizeTools(x.slice().reverse())));
});

test('CA-5: customer-placement-wins — a caller-set cache_control is never disturbed', () => {
  const body = { tools: [{ name: 'z', cache_control: { type: 'ephemeral' } }, { name: 'a' }], messages: [] };
  const r = ca.alignAnthropicBody(body);
  assert.equal(r.applied, false);
  assert.deepEqual(r.body.tools.map((t) => t.name), ['z', 'a'], 'tool order untouched when caller manages caching');
});

test('CA-6: no tools → no normalization, detection still runs', () => {
  const body = { system: 'id 550e8400-e29b-41d4-a716-446655440000', messages: [] };
  const r = ca.alignAnthropicBody(body);
  assert.equal(r.applied, false);
  assert.equal(r.body, body);
  assert.deepEqual(r.findings.map((f) => f.kind), ['uuid']);
});

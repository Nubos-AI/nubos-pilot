'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const steering = require('./output-steering.cjs');

test('OS-1: balanced/unknown profile is a no-op (no shaping block)', () => {
  const p = 'You are an agent.';
  assert.equal(steering.enrichSystemPrompt(p, 'balanced'), p);
  assert.equal(steering.enrichSystemPrompt(p, 'nonsense'), p);
  assert.equal(steering.enrichSystemPrompt(p, undefined), p);
});

test('OS-2: a real profile appends one tagged, byte-stable block', () => {
  const out = steering.enrichSystemPrompt('You are an agent.', 'terse');
  assert.match(out, /^You are an agent\./);
  assert.match(out, /<nubos_output_shaping>[\s\S]*<\/nubos_output_shaping>$/);
  assert.equal(out, steering.enrichSystemPrompt('You are an agent.', 'terse'), 'deterministic');
});

test('OS-3: enrichment is idempotent and profile-switchable (always exactly one block)', () => {
  const once = steering.enrichSystemPrompt('base', 'terse');
  const twice = steering.enrichSystemPrompt(once, 'terse');
  assert.equal(twice, once, 're-enriching with same profile converges');
  const switched = steering.enrichSystemPrompt(once, 'minimal');
  assert.equal((switched.match(/<nubos_output_shaping>/g) || []).length, 1, 'never stacks blocks');
  assert.match(switched, /Minimum tokens/);
  assert.equal(steering.enrichSystemPrompt(once, 'balanced'), 'base', 'balanced strips back to bare prompt');
});

test('OS-4: classifyTurn — fresh user ask', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'do x' }];
  assert.equal(steering.classifyTurn(msgs), 'new_user_ask');
  assert.equal(steering.classifyTurn([]), 'new_user_ask');
});

test('OS-5: classifyTurn — clean tool results are a mechanical continuation', () => {
  const msgs = [
    { role: 'user', content: 'do x' },
    { role: 'assistant', content: '', tool_calls: [] },
    { role: 'tool', tool_call_id: 'a', content: 'file written ok' },
    { role: 'tool', tool_call_id: 'b', content: 'ok' },
  ];
  assert.equal(steering.classifyTurn(msgs), 'mechanical_continuation');
});

test('OS-6: classifyTurn — an error tool result forces full effort', () => {
  const msgs = [
    { role: 'user', content: 'do x' },
    { role: 'assistant', content: '' },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', content: 'Error: file not found' },
  ];
  assert.equal(steering.classifyTurn(msgs), 'error_continuation');
});

test('OS-8: classifyTurn — a fresh user message after a tool turn is a new ask', () => {
  const msgs = [
    { role: 'user', content: 'do x' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'actually do y' },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  assert.equal(steering.classifyTurn(msgs), 'new_user_ask');
});

test('OS-7: routeEffort downgrades only on mechanical turns, never injects or upgrades', () => {
  assert.equal(steering.routeEffort(undefined, 'mechanical_continuation', {}), undefined);
  assert.equal(steering.routeEffort('high', 'mechanical_continuation', { mechanicalEffort: 'low' }), 'low');
  assert.equal(steering.routeEffort('high', 'new_user_ask', { mechanicalEffort: 'low' }), 'high');
  assert.equal(steering.routeEffort('high', 'error_continuation', { mechanicalEffort: 'low' }), 'high');
  assert.equal(steering.routeEffort('low', 'mechanical_continuation', { mechanicalEffort: 'high' }), 'low');
});

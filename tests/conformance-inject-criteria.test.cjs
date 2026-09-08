'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

test('CIC-1 np-executor agent documents the success_criteria acceptance target', () => {
  const md = read('agents/np-executor.md');
  assert.match(md, /## Write against the success_criteria/);
  assert.match(md, /acceptance target/i);
  assert.match(md, /ADR-0019/);
  assert.match(md, /never\b[^.]*\bfiles_modified|outside `files_modified`/i);
});

test('CIC-2 execute-phase reads the gate flag and renders the criteria block', () => {
  const md = read('workflows/execute-phase.md');
  assert.match(md, /config-get conformance\.inject_criteria/);
  assert.match(md, /SUCCESS_CRITERIA_BLOCK/);
  assert.match(md, /success_criteria/);
});

test('CIC-3 executor spawn contract injects success_criteria gated on the flag', () => {
  const md = read('workflows/execute-phase.md');
  assert.match(md, /<success_criteria>/);
  assert.match(md, /\$CONF_INJECT_CRITERIA\s*=\s*true/);
  assert.match(md, /Omit the field entirely when the flag is false/);
});

test('CIC-4 conformance toggle is wired into config defaults and schema', () => {
  const defaults = require('../lib/config-defaults.cjs');
  const schema = require('../lib/config-schema.cjs');
  assert.equal(defaults.DEFAULT_CONFORMANCE.inject_criteria, true);
  assert.equal(defaults.DEFAULT_CONFIG_TREE.conformance.inject_criteria, true);
  assert.ok(schema.SCHEMA.conformance, 'schema has a conformance node');
  assert.deepEqual(schema.validateConfig({ conformance: { inject_criteria: false } }), []);
});

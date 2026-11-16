'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('./session-aggregate.cjs');

function mkSandbox(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sa-'));
  const state = path.join(dir, '.nubos-pilot');
  fs.mkdirSync(path.join(state, 'metrics'), { recursive: true });
  const records = (opts && opts.records) || [];
  const byPhase = {};
  for (const r of records) {
    const key = r.phase || 'meta';
    (byPhase[key] = byPhase[key] || []).push(r);
  }
  for (const key of Object.keys(byPhase)) {
    const fname = key === 'meta' ? 'meta.jsonl' : 'phase-' + key + '.jsonl';
    fs.writeFileSync(
      path.join(state, 'metrics', fname),
      byPhase[key].map((r) => JSON.stringify(r)).join('\n'),
    );
  }
  if (opts && opts.pointer) {
    fs.mkdirSync(path.join(state, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(state, 'reports', '.last-session'), opts.pointer);
  }
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (c) => { chunks.push(c); } },
    read: () => chunks.join(''),
  };
}

test('SA-1: aggregates with no pointer (full project)', async () => {
  const dir = mkSandbox({
    records: [
      {
        schema_version: 2, started_at: '2026-04-10T10:00:00Z', phase: 'P1',
        agent: 'a', tier: 't', resolved_model: 'm',
        plan: 'PL1', task: 'TA1', tokens_in: 10, tokens_out: 20,
        duration_ms: 100, status: 'ok', runtime: 'claude', retry_count: 0,
      },
    ],
  });
  try {
    const cap = captureStdout();
    const rc = await mod.run([], { cwd: dir, stdout: cap.stream });
    assert.equal(rc, 0);
    const out = JSON.parse(cap.read());
    assert.equal(out.record_count, 1);
    assert.equal(out.total_tokens_in, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SA-2: --since override honoured', async () => {
  const dir = mkSandbox({
    records: [
      {
        schema_version: 2, started_at: '2026-04-10T10:00:00Z', phase: 'P1',
        agent: 'a', tier: 't', resolved_model: 'm',
        plan: 'PL1', task: 'TA1', tokens_in: 10, tokens_out: 20,
        duration_ms: 100, status: 'ok', runtime: 'claude', retry_count: 0,
      },
      {
        schema_version: 2, started_at: '2026-04-20T10:00:00Z', phase: 'P1',
        agent: 'a', tier: 't', resolved_model: 'm',
        plan: 'PL1', task: 'TA2', tokens_in: 5, tokens_out: 7,
        duration_ms: 50, status: 'ok', runtime: 'claude', retry_count: 0,
      },
    ],
  });
  try {
    const cap = captureStdout();
    await mod.run(['--since', '2026-04-15T00:00:00Z'], { cwd: dir, stdout: cap.stream });
    const out = JSON.parse(cap.read());
    assert.equal(out.record_count, 1);
    assert.equal(out.total_tokens_in, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SA-3: existing pointer used when no --since override', async () => {
  const dir = mkSandbox({
    pointer: '2026-04-15T00:00:00Z',
    records: [
      {
        schema_version: 2, started_at: '2026-04-10T10:00:00Z', phase: 'P1',
        agent: 'a', tier: 't', resolved_model: 'm',
        plan: 'PL1', task: 'TA1', tokens_in: 10, tokens_out: 20,
        duration_ms: 100, status: 'ok', runtime: 'claude', retry_count: 0,
      },
      {
        schema_version: 2, started_at: '2026-04-20T10:00:00Z', phase: 'P1',
        agent: 'a', tier: 't', resolved_model: 'm',
        plan: 'PL1', task: 'TA2', tokens_in: 5, tokens_out: 7,
        duration_ms: 50, status: 'ok', runtime: 'claude', retry_count: 0,
      },
    ],
  });
  try {
    const cap = captureStdout();
    await mod.run([], { cwd: dir, stdout: cap.stream });
    const out = JSON.parse(cap.read());
    assert.equal(out.record_count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const handler = require('./otlp-export.cjs');

function _ctx(cwd) {
  const out = [];
  const err = [];
  return {
    ctx: { cwd, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const RECORD = {
  agent: 'np-executor',
  tier: 'sonnet',
  resolved_model: 'claude-sonnet-5',
  phase: '1',
  plan: 'M001-S001',
  task: 'M001-S001-T0001',
  started_at: '2026-07-30T10:00:00.000Z',
  ended_at: '2026-07-30T10:00:05.000Z',
  duration_ms: 5000,
  tokens_in: 900,
  tokens_out: 210,
  retry_count: 0,
  status: 'ok',
  runtime: 'claude',
  error: null,
  run_id: 'run-1',
};

/**
 * A minimal but real project: roadmap.yaml declaring one milestone with one
 * slice, a task plan on disk with status frontmatter, and one metrics record.
 */
function _project(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-otlp-'));
  const state = path.join(root, '.nubos-pilot');
  const taskDir = path.join(state, 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(state, 'metrics'), { recursive: true });

  fs.writeFileSync(path.join(state, 'roadmap.yaml'), [
    'schema_version: 2',
    'milestones:',
    '  - id: M001',
    '    name: Password reset',
    '    status: in-progress',
    '    slices:',
    '      - id: S001',
    '        name: Token plumbing',
    '        status: done',
    '',
  ].join('\n'), 'utf-8');

  fs.writeFileSync(path.join(taskDir, 'T0001-PLAN.md'), [
    '---',
    'status: done',
    'title: generate single-use tokens',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'), 'utf-8');

  if (o.records !== null) {
    fs.writeFileSync(
      path.join(state, 'metrics', 'phase-1.jsonl'),
      (o.records || [RECORD]).map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }
  if (o.config) {
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(o.config, null, 2), 'utf-8');
  }
  return root;
}

function _cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('OE-1: no args prints usage and exits non-zero; --help exits zero', async () => {
  const a = _ctx();
  assert.equal(await handler.run([], a.ctx), 1);
  assert.match(a.out(), /Usage:/);
  const b = _ctx();
  assert.equal(await handler.run(['--help'], b.ctx), 0);
  assert.match(b.out(), /telemetry\.otlp/);
});

test('OE-2: collectHierarchy reads milestone/slice from roadmap and task status from disk', () => {
  const root = _project();
  try {
    const tree = handler.collectHierarchy(root, null);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, 'M001');
    assert.equal(tree[0].slices[0].id, 'M001-S001');
    assert.equal(tree[0].slices[0].tasks[0].id, 'M001-S001-T0001');
    assert.equal(tree[0].slices[0].tasks[0].status, 'done');
    assert.equal(tree[0].slices[0].tasks[0].name, 'generate single-use tokens');
  } finally {
    _cleanup(root);
  }
});

test('OE-3: the --milestone filter narrows the hierarchy', () => {
  const root = _project();
  try {
    assert.equal(handler.collectHierarchy(root, 1).length, 1);
    assert.equal(handler.collectHierarchy(root, 2).length, 0);
  } finally {
    _cleanup(root);
  }
});

test('OE-4: dry-run emits a valid OTLP envelope with the nested span tree', async () => {
  const root = _project();
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['dry-run'], c.ctx), 0);
    const payload = JSON.parse(c.out());
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const names = spans.map((s) => s.name);
    assert.ok(names.includes('milestone M001'));
    assert.ok(names.includes('slice M001-S001'));
    assert.ok(names.includes('task M001-S001-T0001'));
    assert.ok(names.includes('agent np-executor'));
  } finally {
    _cleanup(root);
  }
});

test('OE-5: stats counts each unit and reports malformed metric lines', async () => {
  const root = _project();
  try {
    fs.appendFileSync(path.join(root, '.nubos-pilot', 'metrics', 'phase-1.jsonl'), '{ truncated\n', 'utf-8');
    const c = _ctx(root);
    assert.equal(await handler.run(['stats'], c.ctx), 0);
    const stats = JSON.parse(c.out());
    assert.equal(stats.milestones, 1);
    assert.equal(stats.slices, 1);
    assert.equal(stats.tasks, 1);
    assert.equal(stats.spawns, 1);
    // A crash mid-append must not make the whole history unexportable.
    assert.equal(stats.malformed_metric_lines, 1);
  } finally {
    _cleanup(root);
  }
});

test('OE-6: a project with no metrics directory exports nothing rather than throwing', async () => {
  const root = _project({ records: null });
  try {
    fs.rmSync(path.join(root, '.nubos-pilot', 'metrics'), { recursive: true, force: true });
    const c = _ctx(root);
    assert.equal(await handler.run(['stats'], c.ctx), 0);
    assert.equal(JSON.parse(c.out()).total_spans, 0);
  } finally {
    _cleanup(root);
  }
});

test('OE-7: write persists the payload to --out and requires the flag', async () => {
  const root = _project();
  const out = path.join(root, 'spans.json');
  try {
    const missing = _ctx(root);
    assert.equal(await handler.run(['write'], missing.ctx), 1);
    assert.match(missing.err(), /otlp-missing-out/);

    const c = _ctx(root);
    assert.equal(await handler.run(['write', '--out', out], c.ctx), 0);
    assert.ok(fs.existsSync(out));
    assert.ok(JSON.parse(fs.readFileSync(out, 'utf-8')).resourceSpans);
  } finally {
    _cleanup(root);
  }
});

test('OE-8: send refuses while telemetry.otlp.enabled is false', async () => {
  const root = _project();
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send'], c.ctx), 1);
    assert.match(c.err(), /otlp-disabled/);
  } finally {
    _cleanup(root);
  }
});

test('OE-9: dry-run and write work with telemetry disabled — local inspection is not egress', async () => {
  const root = _project();
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['dry-run'], c.ctx), 0);
    const w = _ctx(root);
    assert.equal(await handler.run(['write', '--out', path.join(root, 'x.json')], w.ctx), 0);
  } finally {
    _cleanup(root);
  }
});

test('OE-10: send with telemetry enabled but no endpoint refuses instead of guessing localhost', async () => {
  const root = _project({ config: { telemetry: { otlp: { enabled: true } } } });
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send'], c.ctx), 1);
    assert.match(c.err(), /otlp-no-endpoint-configured/);
  } finally {
    _cleanup(root);
  }
});

test('OE-11: send posts the envelope and reports the status', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/traces';
  const root = _project({
    config: { telemetry: { otlp: { enabled: true, endpoint, headers: { authorization: 'Bearer t' } } } },
  });
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send'], c.ctx), 0);
    const payload = JSON.parse(c.out());
    assert.equal(payload.sent, true);
    assert.equal(payload.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers.authorization, 'Bearer t');
    assert.ok(JSON.parse(received[0].body).resourceSpans);
  } finally {
    server.close();
    _cleanup(root);
  }
});

test('OE-12: send reports a no-op instead of posting an empty envelope', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(200); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/traces';
  const root = _project({ records: [], config: { telemetry: { otlp: { enabled: true, endpoint } } } });
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send'], c.ctx), 0);
    const payload = JSON.parse(c.out());
    assert.equal(payload.sent, false);
    assert.match(payload.reason, /no spans/);
    assert.equal(hits, 0, 'an empty export must not hit the network at all');
  } finally {
    server.close();
    _cleanup(root);
  }
});

test('OE-13: a rejected export surfaces the backend status rather than reporting success', async () => {
  const server = http.createServer((req, res) => { res.writeHead(403); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/traces';
  const root = _project({ config: { telemetry: { otlp: { enabled: true, endpoint } } } });
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send'], c.ctx), 1);
    assert.match(c.err(), /otlp-export-rejected/);
    assert.match(c.err(), /403/);
  } finally {
    server.close();
    _cleanup(root);
  }
});

test('OE-14: --endpoint overrides config but still requires enabled', async () => {
  const root = _project();
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['send', '--endpoint', 'http://127.0.0.1:1/v1/traces'], c.ctx), 1);
    assert.match(c.err(), /otlp-disabled/, 'a flag must not be able to switch on egress by itself');
  } finally {
    _cleanup(root);
  }
});

test('OE-15: a bad --milestone value is refused', async () => {
  const root = _project();
  try {
    const c = _ctx(root);
    assert.equal(await handler.run(['stats', '--milestone', 'abc'], c.ctx), 1);
    assert.match(c.err(), /otlp-bad-milestone/);
  } finally {
    _cleanup(root);
  }
});

test('OE-16: repeated exports of the same project produce identical ids', async () => {
  const root = _project();
  try {
    const a = _ctx(root);
    await handler.run(['dry-run'], a.ctx);
    const b = _ctx(root);
    await handler.run(['dry-run'], b.ctx);
    assert.equal(a.out(), b.out(), 're-export must update one trace, not accumulate duplicates');
  } finally {
    _cleanup(root);
  }
});

test('OE-17: an unknown verb lists the allowed set', async () => {
  const c = _ctx();
  assert.equal(await handler.run(['frobnicate'], c.ctx), 1);
  assert.match(c.err(), /otlp-unknown-verb/);
  assert.match(c.err(), /dry-run/);
});

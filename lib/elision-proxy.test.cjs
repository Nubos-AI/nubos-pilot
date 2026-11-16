'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const child_process = require('node:child_process');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const proxy = require('./elision-proxy.cjs');

function bigLog() {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(i % 71 === 0 ? ('ERROR: boom at svc_' + i) : ('[info] step ' + i + ' ok ' + 'x'.repeat(40)));
  }
  return lines.join('\n');
}

function fakeCx(store) {
  return { enabled: true, minBlockBytes: 100, verifyMaxBytes: 2000, store: store || (() => 'abcdef012345') };
}

const _servers = [];
const _dirs = [];
const _procs = [];
afterEach(() => {
  while (_procs.length) { try { _procs.pop().kill(); } catch {} }
  while (_servers.length) { try { _servers.pop().close(); } catch {} }
  while (_dirs.length) { try { fs.rmSync(_dirs.pop(), { recursive: true, force: true }); } catch {} }
});
function ws(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'np-proxy-')));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  _dirs.push(root);
  return root;
}

test('PXY-1: compresses a large tool_result and stores the original; cache_control + ids survive', () => {
  const seen = [];
  const body = {
    model: 'claude',
    system: [{ type: 'text', text: 'SYSTEM PROMPT '.repeat(50), cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', is_error: false, cache_control: { type: 'ephemeral' }, content: bigLog() },
      ] },
    ],
  };
  const out = proxy.compressAnthropicBody(body, fakeCx((orig) => { seen.push(orig); return 'abcdef012345'; }));
  assert.equal(out.stats.blocks_compressed, 1);
  assert.ok(out.stats.bytes_after < out.stats.bytes_before);
  const tr = out.body.messages[1].content[0];
  assert.ok(tr.content.includes('⟦elided:abcdef012345'), 'marker injected into tool_result');
  assert.deepEqual(tr.cache_control, { type: 'ephemeral' }, 'cache_control preserved');
  assert.equal(tr.tool_use_id, 'tu_1');
  assert.equal(tr.is_error, false);
  assert.equal(seen.length, 1, 'original stored once');
  assert.ok(seen[0].includes('ERROR: boom at svc_0'), 'raw original captured');
});

test('PXY-2: system blocks and ordinary text are never touched (cached prefix stays byte-identical)', () => {
  const sys = 'SYSTEM '.repeat(500);
  const body = {
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(5000) }] }],
  };
  const out = proxy.compressAnthropicBody(body, fakeCx());
  assert.equal(out.stats.blocks_compressed, 0);
  assert.equal(out.body.system[0].text, sys);
  assert.equal(out.body.messages[0].content[0].text, 'A'.repeat(5000));
});

test('PXY-3: small tool_result is left verbatim', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'tiny' }] }] };
  const out = proxy.compressAnthropicBody(body, fakeCx());
  assert.equal(out.stats.blocks_compressed, 0);
  assert.equal(out.body.messages[0].content[0].content, 'tiny');
});

test('PXY-4: deterministic — same body compresses to the same bytes (cache-stable across turns)', () => {
  const mk = () => ({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: bigLog() }] }] });
  const a = proxy.compressAnthropicBody(mk(), fakeCx());
  const b = proxy.compressAnthropicBody(mk(), fakeCx());
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('PXY-5: array-form tool_result content compresses its text blocks', () => {
  const body = { messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: bigLog() }] },
  ] }] };
  const out = proxy.compressAnthropicBody(body, fakeCx());
  assert.equal(out.stats.blocks_compressed, 1);
  assert.ok(out.body.messages[0].content[0].content[0].text.includes('⟦elided:'));
});

test('PXY-6: disabled compression context is a no-op', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: bigLog() }] }] };
  const out = proxy.compressAnthropicBody(body, { enabled: false, store: () => 'x' });
  assert.equal(out.stats.blocks_compressed, 0);
  assert.equal(out.body, body);
});

test('PXY-7: end-to-end — child request is crushed in flight, forwarded, response piped back', async () => {
  const cwd = ws({ '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true } }) });

  let received = null;
  const upstream = http.createServer((req, res) => {
    const cs = [];
    req.on('data', (c) => cs.push(c));
    req.on('end', () => {
      received = { path: req.url, auth: req.headers['x-api-key'], body: Buffer.concat(cs).toString('utf-8') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'msg_123' }));
    });
  });
  _servers.push(upstream);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;

  const { server, baseUrl } = await proxy.start({ cwd, upstream: upstreamUrl });
  _servers.push(server);

  const reqBody = JSON.stringify({
    model: 'claude',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: bigLog() }] }],
  });
  const resp = await new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/v1/messages');
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'content-length': Buffer.byteLength(reqBody) } },
      (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf-8') })); });
    r.on('error', reject);
    r.end(reqBody);
  });

  assert.equal(resp.status, 200);
  assert.deepEqual(JSON.parse(resp.body), { ok: true, id: 'msg_123' }, 'upstream response piped through unchanged');
  assert.equal(received.path, '/v1/messages', 'path forwarded');
  assert.equal(received.auth, 'sk-test', 'auth header forwarded');
  assert.ok(received.body.length < reqBody.length, 'upstream got a smaller body');
  assert.ok(received.body.includes('⟦elided:'), 'tool_result was crushed in flight');
  const hash = JSON.parse(received.body).messages[0].content[0].content.match(/⟦elided:([a-f0-9]{12})/)[1];
  const back = require('./elision.cjs').retrieve(hash, cwd);
  assert.equal(back.status, 'ok');
  assert.ok(back.original.includes('ERROR: boom at svc_0'), 'original recoverable from the ledger');
});

test('PXY-10: cache_align normalizes tools and adds a breakpoint in flight when opted in', async () => {
  const cwd = ws({ '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true, cache_align: { enabled: true } } }) });
  let received = null;
  const upstream = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c));
    req.on('end', () => { received = Buffer.concat(cs).toString('utf-8'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  _servers.push(upstream);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { server, baseUrl } = await proxy.start({ cwd, upstream: 'http://127.0.0.1:' + upstream.address().port });
  _servers.push(server);

  const reqBody = JSON.stringify({
    model: 'claude',
    system: 'plain stable system',
    tools: [{ name: 'zeta' }, { name: 'alpha' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  await new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/v1/messages');
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) } },
      (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', resolve); });
    r.on('error', reject);
    r.end(reqBody);
  });
  const got = JSON.parse(received);
  assert.deepEqual(got.tools.map((t) => t.name), ['alpha', 'zeta'], 'tools sorted for a stable prefix');
  assert.deepEqual(got.tools[1].cache_control, { type: 'ephemeral' }, 'breakpoint added on the last tool');
});

test('PXY-9: forked entry reports its baseUrl over IPC and crushes traffic (spawn-headless mechanism)', async () => {
  const cwd = ws({ '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true, proxy: { enabled: true } } }) });
  let received = null;
  const upstream = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c));
    req.on('end', () => { received = Buffer.concat(cs).toString('utf-8'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  _servers.push(upstream);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const entry = path.join(__dirname, '..', 'bin', 'np-tools', '_elision-proxy-entry.cjs');
  const proc = child_process.fork(entry, [], {
    env: Object.assign({}, process.env, { ELISION_PROXY_CWD: cwd, ELISION_PROXY_UPSTREAM: 'http://127.0.0.1:' + upstream.address().port }),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  _procs.push(proc);
  const baseUrl = await new Promise((resolve, reject) => {
    proc.once('message', (m) => (m && m.ready ? resolve(m.baseUrl) : reject(new Error(m && m.error))));
    proc.once('error', reject);
  });
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const reqBody = JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: bigLog() }] }] });
  const status = await new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/v1/messages');
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(reqBody);
  });
  assert.equal(status, 200);
  assert.ok(received && received.includes('⟦elided:'), 'forked proxy crushed the tool_result before forwarding');
});

test('PXY-8: non-JSON body is forwarded untouched (no crash)', async () => {
  const cwd = ws({ '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true } }) });
  let received = null;
  const upstream = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c));
    req.on('end', () => { received = Buffer.concat(cs).toString('utf-8'); res.writeHead(200); res.end('pong'); });
  });
  _servers.push(upstream);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { server, baseUrl } = await proxy.start({ cwd, upstream: 'http://127.0.0.1:' + upstream.address().port });
  _servers.push(server);

  const resp = await new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/v1/messages');
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': 11 } }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf-8') }));
    });
    r.on('error', reject); r.end('not a json!');
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body, 'pong');
  assert.equal(received, 'not a json!', 'non-JSON forwarded verbatim');
});

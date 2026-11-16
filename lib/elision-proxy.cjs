'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const compress = require('./compress.cjs');
const elision = require('./elision.cjs');
const cacheAlign = require('./cache-align.cjs');
const config = require('./config.cjs');
const { DEFAULT_COMPRESSION } = require('./config-defaults.cjs');
const logger = require('./logger.cjs').child('elision-proxy');

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

function proxyEnabled(cwd) {
  if (!elision.compressionContext(cwd).enabled) return false;
  let cfg;
  try { cfg = config.tryReadConfigPath(cwd, 'compression', DEFAULT_COMPRESSION) || DEFAULT_COMPRESSION; }
  catch { cfg = DEFAULT_COMPRESSION; }
  return !!(cfg.proxy && cfg.proxy.enabled === true);
}

function _squeeze(text, cx, acc) {
  let res;
  try {
    res = compress.compressBlock(text, { minBlockBytes: cx.minBlockBytes, store: cx.store });
  } catch {
    return text;
  }
  if (!res || !res.changed) return text;
  acc.blocks_compressed += 1;
  acc.bytes_before += Buffer.byteLength(text, 'utf-8');
  acc.bytes_after += Buffer.byteLength(res.compressed, 'utf-8');
  return res.compressed;
}

function compressAnthropicBody(body, cx) {
  const acc = { blocks_compressed: 0, bytes_before: 0, bytes_after: 0 };
  if (!cx || !cx.enabled || typeof cx.store !== 'function' || !body || !Array.isArray(body.messages)) {
    return { body, stats: acc };
  }
  const messages = body.messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const content = msg.content.map((block) => {
      if (!block || block.type !== 'tool_result') return block;
      const c = block.content;
      if (typeof c === 'string') {
        const sq = _squeeze(c, cx, acc);
        return sq === c ? block : Object.assign({}, block, { content: sq });
      }
      if (Array.isArray(c)) {
        let changed = false;
        const nc = c.map((b) => {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const sq = _squeeze(b.text, cx, acc);
            if (sq !== b.text) { changed = true; return Object.assign({}, b, { text: sq }); }
          }
          return b;
        });
        return changed ? Object.assign({}, block, { content: nc }) : block;
      }
      return block;
    });
    return Object.assign({}, msg, { content });
  });
  return { body: Object.assign({}, body, { messages }), stats: acc };
}

function _upstreamPath(upstreamUrl, reqUrl) {
  const base = upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname.replace(/\/$/, '');
  return base + reqUrl;
}

function createServer(opts) {
  const o = opts || {};
  const cwd = o.cwd;
  const upstreamUrl = new URL(o.upstream || DEFAULT_UPSTREAM);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const onStats = typeof o.onStats === 'function' ? o.onStats : null;
  const cxImpl = o.compressionContext || elision.compressionContext;
  const warnedVolatile = new Set();

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('error', () => { try { res.destroy(); } catch { /* client gone */ } });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let outBody = Buffer.concat(chunks);
      try {
        const cx = cxImpl(cwd);
        if (cx && cx.enabled) {
          const parsed = JSON.parse(outBody.toString('utf-8'));
          const t = compressAnthropicBody(parsed, cx);
          let nextBody = t.body;
          let dirty = t.stats.blocks_compressed > 0;
          if (t.stats.blocks_compressed > 0 && onStats) {
            try { onStats(t.stats); } catch { /* observer must not break proxying */ }
          }
          if (cx.cacheAlign) {
            const a = cacheAlign.alignAnthropicBody(nextBody);
            for (const f of a.findings) {
              if (warnedVolatile.has(f.kind)) continue;
              warnedVolatile.add(f.kind);
              logger.warn('volatile token in system prompt breaks prompt cache', { kind: f.kind });
            }
            if (a.applied) { nextBody = a.body; dirty = true; }
          }
          if (dirty) outBody = Buffer.from(JSON.stringify(nextBody), 'utf-8');
        }
      } catch (err) {
        logger.warn('passthrough (body not transformed)', { cause: err && err.message });
      }

      const headers = Object.assign({}, req.headers);
      headers.host = upstreamUrl.host;
      headers['content-length'] = String(Buffer.byteLength(outBody));

      const fwd = transport.request({
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        method: req.method,
        path: _upstreamPath(upstreamUrl, req.url),
        headers,
      }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      });
      fwd.on('error', (err) => {
        logger.warn('upstream error', { cause: err && err.message });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'elision_proxy_upstream_error', message: String(err && err.message) } }));
      });
      fwd.end(outBody);
    });
  });
}

function start(opts) {
  const server = createServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen((opts && opts.port) || 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: 'http://127.0.0.1:' + port });
    });
  });
}

module.exports = {
  DEFAULT_UPSTREAM,
  proxyEnabled,
  compressAnthropicBody,
  createServer,
  start,
};

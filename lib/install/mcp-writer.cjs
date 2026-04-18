const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicWriteFileSync, NubosPilotError } = require('../core.cjs');

const DEFAULT_MCP_NAME = 'nubos';
const DEFAULT_MCP_URL = 'https://mcp.nubos.cloud/mcp/nubos';
const DEFAULT_MCP_TOKEN = '4f81676a6be2f069d55769e877d133dba44a98ea263e24b5dfecd7fb7ed448ba';

function _resolveTarget(runtime, scope, projectRoot, home) {
  const h = home || os.homedir();
  if (runtime === 'claude') {
    return scope === 'global'
      ? { kind: 'claude-json', path: path.join(h, '.claude.json') }
      : { kind: 'claude-json', path: path.join(projectRoot, '.mcp.json') };
  }
  if (runtime === 'codex') {
    return { kind: 'codex-toml', path: path.join(h, '.codex', 'config.toml') };
  }
  if (runtime === 'gemini') {
    return scope === 'global'
      ? { kind: 'gemini-json', path: path.join(h, '.gemini', 'settings.json') }
      : { kind: 'gemini-json', path: path.join(projectRoot, '.gemini', 'settings.json') };
  }
  if (runtime === 'opencode') {
    return scope === 'global'
      ? { kind: 'opencode-json', path: path.join(h, '.config', 'opencode', 'opencode.json') }
      : { kind: 'opencode-json', path: path.join(projectRoot, 'opencode.json') };
  }
  throw new NubosPilotError('unknown-runtime',
    'Unknown runtime for MCP config: ' + runtime, { runtime });
}

function _readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return {}; }
}

function _writeJson(target, nextObj, dryRun) {
  if (dryRun) return { path: target.path, wouldWrite: true };
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  atomicWriteFileSync(target.path, JSON.stringify(nextObj, null, 2) + '\n');
  return { path: target.path, wrote: true };
}

function _claudeWriter({ target, token, url, name, dryRun }) {
  const existing = _readJson(target.path);
  const servers = existing.mcpServers || {};
  servers[name] = {
    type: 'http',
    url,
    headers: { Authorization: 'Bearer ' + token },
  };
  existing.mcpServers = servers;
  return _writeJson(target, existing, dryRun);
}

function _geminiWriter({ target, token, url, name, dryRun }) {
  const existing = _readJson(target.path);
  const servers = existing.mcpServers || {};
  servers[name] = {
    httpUrl: url,
    headers: { Authorization: 'Bearer ' + token },
  };
  existing.mcpServers = servers;
  return _writeJson(target, existing, dryRun);
}

function _opencodeWriter({ target, token, url, name, dryRun }) {
  const existing = _readJson(target.path);
  if (!existing.$schema) existing.$schema = 'https://opencode.ai/config.json';
  const mcp = existing.mcp || {};
  mcp[name] = {
    type: 'remote',
    url,
    headers: { Authorization: 'Bearer ' + token },
  };
  existing.mcp = mcp;
  return _writeJson(target, existing, dryRun);
}

function _codexWriter({ target, token, url, name, dryRun }) {
  const existing = fs.existsSync(target.path)
    ? fs.readFileSync(target.path, 'utf-8') : '';
  const header = '[mcp_servers.' + name + ']';
  if (existing.includes(header)) {
    return { path: target.path, wrote: false, reason: 'already-configured' };
  }
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const block = prefix
    + '\n' + header + '\n'
    + 'command = "npx"\n'
    + 'args = ["-y", "mcp-remote", "' + url + '", "--header", "Authorization: Bearer ' + token + '"]\n';
  if (dryRun) return { path: target.path, wouldWrite: true };
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  atomicWriteFileSync(target.path, existing + block);
  return { path: target.path, wrote: true };
}

const WRITERS = {
  'claude-json': _claudeWriter,
  'gemini-json': _geminiWriter,
  'opencode-json': _opencodeWriter,
  'codex-toml': _codexWriter,
};

function writeMcpConfig(opts) {
  const o = opts || {};
  if (!o.runtime) throw new NubosPilotError('missing-arg', 'runtime is required');
  if (!o.projectRoot) throw new NubosPilotError('missing-arg', 'projectRoot is required');
  const scope = o.scope || 'local';
  const token = o.token || process.env.NUBOS_MCP_TOKEN || DEFAULT_MCP_TOKEN;
  const url = o.url || process.env.NUBOS_MCP_URL || DEFAULT_MCP_URL;
  const name = o.name || DEFAULT_MCP_NAME;
  const target = _resolveTarget(o.runtime, scope, o.projectRoot, o.home);
  const writer = WRITERS[target.kind];
  return writer({ target, token, url, name, dryRun: !!o.dryRun });
}

module.exports = {
  writeMcpConfig,
  DEFAULT_MCP_NAME,
  DEFAULT_MCP_URL,
  DEFAULT_MCP_TOKEN,
  _resolveTarget,
};

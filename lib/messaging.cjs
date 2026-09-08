'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync, atomicCreateExclusiveSync, fsyncDir, appendJsonl, withFileLock, NubosPilotError, projectStateDir } = require('./core.cjs');
const { validate, assertValid } = require('./validate.cjs');

function _runId() {
  try { return require('./run-context.cjs').getRunId(); }
  catch { return null; }
}

const KIND_ENUM = new Set(['request', 'response', 'notify']);
const AGENT_RE = /^[a-zA-Z0-9_-]+$/;
const ID_RE = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 256 * 1024;
const MESSAGE_SCHEMA = 'message.v1';

function _messagesRoot(cwd) {
  return path.join(projectStateDir(cwd || process.cwd()), 'messages');
}

function _inboxDir(cwd, agent) {
  return path.join(_messagesRoot(cwd), 'inbox', agent);
}

function _archiveDir(cwd) {
  return path.join(_messagesRoot(cwd), 'archive');
}

function _byTaskDir(cwd, taskId) {
  return path.join(_messagesRoot(cwd), 'archive', 'by-task', taskId);
}

function _manifestPath(cwd) {
  return path.join(_messagesRoot(cwd), 'manifest.jsonl');
}

let _lastMs = 0;
function _genId() {
  let ms = Date.now();
  if (ms <= _lastMs) ms = _lastMs + 1;
  _lastMs = ms;
  return ms + '-' + crypto.randomUUID();
}

function _validateAgentName(field, value) {
  if (typeof value !== 'string' || value.length === 0 || !AGENT_RE.test(value)) {
    throw new NubosPilotError(
      'messages-invalid-agent',
      `${field} must be non-empty agent slug (alphanumerics, _, or -); got: ${JSON.stringify(value)}`,
      { field, value },
    );
  }
}

function _validateKind(kind) {
  if (!KIND_ENUM.has(kind)) {
    throw new NubosPilotError(
      'messages-invalid-kind',
      `kind '${kind}' not in [${[...KIND_ENUM].join(', ')}]`,
      { kind },
    );
  }
}

function _validateMsgId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new NubosPilotError(
      'messages-invalid-id',
      `msg-id must match <unix-ms>-<uuid> pattern; got: ${JSON.stringify(id)}`,
      { id },
    );
  }
}

function _appendManifest(cwd, event) {
  const root = _messagesRoot(cwd);
  fs.mkdirSync(root, { recursive: true });
  appendJsonl(_manifestPath(cwd), event);
}

function _readMessageFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (validate(parsed, MESSAGE_SCHEMA).length > 0) return null;
  Object.defineProperty(parsed, '__path', { value: filePath, enumerable: false });
  return parsed;
}

function _scanDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const msg = _readMessageFile(path.join(dir, name));
    if (msg) out.push(msg);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function _stripPath(msg) {
  const out = {};
  for (const k of Object.keys(msg)) out[k] = msg[k];
  return out;
}

function send(opts, cwd) {
  const o = opts || {};
  _validateAgentName('from', o.from);
  _validateAgentName('to', o.to);
  _validateKind(o.kind);
  if (typeof o.subject !== 'string' || o.subject.length === 0) {
    throw new NubosPilotError('messages-missing-subject', 'subject required (non-empty string)', {});
  }
  if (typeof o.body !== 'string') {
    throw new NubosPilotError('messages-missing-body', 'body required (string, may be empty)', {});
  }
  if (Buffer.byteLength(o.body, 'utf-8') > MAX_BODY_BYTES) {
    throw new NubosPilotError(
      'messages-body-too-large',
      `body exceeds ${MAX_BODY_BYTES} bytes (got ${Buffer.byteLength(o.body, 'utf-8')})`,
      { max_bytes: MAX_BODY_BYTES, actual_bytes: Buffer.byteLength(o.body, 'utf-8') },
    );
  }
  if (typeof o.phase !== 'string' || o.phase.length === 0) {
    throw new NubosPilotError('messages-missing-phase', 'phase (task-id) required as non-empty string', {});
  }
  if (o.expects_reply !== undefined && o.expects_reply !== null && typeof o.expects_reply !== 'boolean') {
    throw new NubosPilotError('messages-invalid-expects-reply', 'expects_reply must be boolean', {});
  }
  if (o.in_reply_to !== undefined && o.in_reply_to !== null && typeof o.in_reply_to !== 'string') {
    throw new NubosPilotError('messages-invalid-in-reply-to', 'in_reply_to must be string or null', {});
  }
  if (o.kind === 'response' && (typeof o.in_reply_to !== 'string' || o.in_reply_to.length === 0)) {
    throw new NubosPilotError('messages-response-needs-in-reply-to', 'response messages must set in_reply_to', {});
  }
  if (o.round !== undefined && o.round !== null && (typeof o.round !== 'number' || !Number.isInteger(o.round) || o.round < 0)) {
    throw new NubosPilotError('messages-invalid-round', 'round must be non-negative integer or null', { round: o.round });
  }

  const id = _genId();
  const createdAt = new Date().toISOString();
  const message = {
    id,
    from: o.from,
    to: o.to,
    phase: o.phase,
    round: o.round ?? null,
    kind: o.kind,
    subject: o.subject,
    body: o.body,
    expects_reply: Boolean(o.expects_reply),
    in_reply_to: o.in_reply_to || null,
    created_at: createdAt,
  };
  assertValid(message, MESSAGE_SCHEMA, 'messages-invalid-record', { id });

  const workingDir = cwd || process.cwd();
  const dir = _inboxDir(workingDir, o.to);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, id + '.json');
  const manifestPath = _manifestPath(workingDir);
  fs.mkdirSync(_messagesRoot(workingDir), { recursive: true });
  withFileLock(manifestPath, () => {
    try {
      atomicCreateExclusiveSync(target, JSON.stringify(message, null, 2));
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        throw new NubosPilotError(
          'messages-send-conflict',
          `message id ${id} already exists at ${target}`,
          { id, path: target, cause: 'EEXIST' },
        );
      }
      throw err;
    }
    appendJsonl(manifestPath, {
      event: 'sent',
      id,
      from: o.from,
      to: o.to,
      kind: o.kind,
      phase: o.phase,
      round: message.round,
      in_reply_to: message.in_reply_to,
      expects_reply: message.expects_reply,
      created_at: createdAt,
      run_id: _runId(),
    }, { lock: false });
  });

  return { id, path: target };
}

function inbox(agent, opts, cwd) {
  _validateAgentName('agent', agent);
  const o = opts || {};
  const workingDir = cwd || process.cwd();
  let messages = _scanDir(_inboxDir(workingDir, agent));
  if (o.kind) {
    _validateKind(o.kind);
    messages = messages.filter((m) => m.kind === o.kind);
  }
  if (o.since) {
    if (typeof o.since !== 'string') {
      throw new NubosPilotError('messages-invalid-since', 'since must be ISO-8601 string', { since: o.since });
    }
    messages = messages.filter((m) => m.created_at > o.since);
  }
  if (o.phase) {
    messages = messages.filter((m) => m.phase === o.phase);
  }
  return messages.map(_stripPath);
}

function _findInInbox(workingDir, msgId) {
  const inboxRoot = path.join(_messagesRoot(workingDir), 'inbox');
  let agents;
  try { agents = fs.readdirSync(inboxRoot, { withFileTypes: true }); } catch { return null; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const cand = path.join(inboxRoot, a.name, msgId + '.json');
    if (fs.existsSync(cand)) {
      const msg = _readMessageFile(cand);
      if (msg) return { msg, location: 'inbox', path: cand };
    }
  }
  return null;
}

function _findInArchive(workingDir, msgId) {
  const direct = path.join(_archiveDir(workingDir), msgId + '.json');
  if (fs.existsSync(direct)) {
    const msg = _readMessageFile(direct);
    if (msg) return { msg, location: 'archive', path: direct };
  }
  const byTaskRoot = path.join(_archiveDir(workingDir), 'by-task');
  let tasks;
  try { tasks = fs.readdirSync(byTaskRoot, { withFileTypes: true }); } catch { return null; }
  for (const t of tasks) {
    if (!t.isDirectory()) continue;
    const cand = path.join(byTaskRoot, t.name, msgId + '.json');
    if (fs.existsSync(cand)) {
      const msg = _readMessageFile(cand);
      if (msg) return { msg, location: 'archive-by-task', path: cand };
    }
  }
  return null;
}

function _findMessage(workingDir, msgId) {
  return _findInInbox(workingDir, msgId) || _findInArchive(workingDir, msgId);
}

function _hasReply(workingDir, requestId) {
  const inboxRoot = path.join(_messagesRoot(workingDir), 'inbox');
  let agents;
  try { agents = fs.readdirSync(inboxRoot, { withFileTypes: true }); } catch { agents = []; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const msgs = _scanDir(path.join(inboxRoot, a.name));
    if (msgs.some((m) => m.kind === 'response' && m.in_reply_to === requestId)) return true;
  }
  const archiveMsgs = _scanDir(_archiveDir(workingDir));
  if (archiveMsgs.some((m) => m.kind === 'response' && m.in_reply_to === requestId)) return true;
  return false;
}

function archive(msgId, cwd) {
  _validateMsgId(msgId);
  const workingDir = cwd || process.cwd();

  return withFileLock(_manifestPath(workingDir), () => {
    const located = _findMessage(workingDir, msgId);
    if (!located) {
      throw new NubosPilotError('messages-not-found', `no message with id ${msgId}`, { id: msgId });
    }
    if (located.location !== 'inbox') {
      throw new NubosPilotError(
        'messages-already-archived',
        `message ${msgId} is not in inbox (location=${located.location})`,
        { id: msgId, location: located.location },
      );
    }
    const msg = located.msg;
    if (msg.kind === 'request' && msg.expects_reply && !_hasReply(workingDir, msgId)) {
      throw new NubosPilotError(
        'messages-archive-without-reply',
        `request ${msgId} has expects_reply=true and no response with in_reply_to=${msgId}; send a response first`,
        { id: msgId },
      );
    }

    const targetDir = _archiveDir(workingDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, msgId + '.json');
    try {
      fs.renameSync(located.path, target);
      try { fsyncDir(targetDir); } catch {}
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const racedToArchive = fs.existsSync(target);
        const event = racedToArchive ? 'archive-race-noop' : 'archive-vanished';
        appendJsonl(_manifestPath(workingDir), {
          event,
          id: msgId,
          phase: msg.phase,
          created_at: new Date().toISOString(),
        }, { lock: false });
        if (racedToArchive) {
          throw new NubosPilotError(
            'messages-already-archived',
            `message ${msgId} was archived by a peer before this call could complete`,
            { id: msgId, cause: 'ENOENT' },
          );
        }
        throw new NubosPilotError(
          'messages-vanished',
          `message ${msgId} disappeared from inbox without reaching archive`,
          { id: msgId, cause: 'ENOENT' },
        );
      }
      throw err;
    }
    appendJsonl(_manifestPath(workingDir), {
      event: 'archived',
      id: msgId,
      from: msg.from,
      to: msg.to,
      kind: msg.kind,
      phase: msg.phase,
      created_at: new Date().toISOString(),
      run_id: _runId(),
    }, { lock: false });
  });
}

function thread(msgId, cwd) {
  _validateMsgId(msgId);
  const workingDir = cwd || process.cwd();
  const seen = new Map();
  function visit(id) {
    if (seen.has(id)) return;
    const located = _findMessage(workingDir, id);
    if (!located) return;
    seen.set(id, located.msg);
    if (located.msg.in_reply_to) visit(located.msg.in_reply_to);
  }
  visit(msgId);

  const root = _messagesRoot(workingDir);
  const dirs = [_archiveDir(workingDir)];
  try {
    const inboxRoot = path.join(root, 'inbox');
    for (const a of fs.readdirSync(inboxRoot, { withFileTypes: true })) {
      if (a.isDirectory()) dirs.push(path.join(inboxRoot, a.name));
    }
  } catch {}
  try {
    const byTaskRoot = path.join(root, 'archive', 'by-task');
    for (const t of fs.readdirSync(byTaskRoot, { withFileTypes: true })) {
      if (t.isDirectory()) dirs.push(path.join(byTaskRoot, t.name));
    }
  } catch {}

  let changed = true;
  while (changed) {
    changed = false;
    for (const dir of dirs) {
      for (const m of _scanDir(dir)) {
        if (m.in_reply_to && seen.has(m.in_reply_to) && !seen.has(m.id)) {
          seen.set(m.id, m);
          changed = true;
        }
      }
    }
  }

  const collected = [...seen.values()].map(_stripPath);
  collected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return collected;
}

function pendingReplies(taskId, cwd) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new NubosPilotError('messages-missing-task-id', 'task_id required as non-empty string', {});
  }
  const workingDir = cwd || process.cwd();
  const inboxRoot = path.join(_messagesRoot(workingDir), 'inbox');
  const out = [];
  let agents;
  try { agents = fs.readdirSync(inboxRoot, { withFileTypes: true }); } catch { return []; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    for (const m of _scanDir(path.join(inboxRoot, a.name))) {
      if (m.phase === taskId && m.kind === 'request' && m.expects_reply) out.push(m);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.map(_stripPath);
}

function sweepTaskOnCommit(taskId, cwd) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new NubosPilotError('messages-missing-task-id', 'task_id required', {});
  }
  const workingDir = cwd || process.cwd();
  const targetDir = _byTaskDir(workingDir, taskId);
  fs.mkdirSync(targetDir, { recursive: true });
  let moved = 0;

  const inboxRoot = path.join(_messagesRoot(workingDir), 'inbox');
  return withFileLock(_manifestPath(workingDir), () => {
    let agents;
    let failure = null;
    try {
      try { agents = fs.readdirSync(inboxRoot, { withFileTypes: true }); } catch { agents = []; }
      for (const a of agents) {
        if (!a.isDirectory()) continue;
        const dir = path.join(inboxRoot, a.name);
        for (const m of _scanDir(dir)) {
          if (m.phase !== taskId) continue;
          const src = m.__path;
          const dst = path.join(targetDir, m.id + '.json');
          try { fs.renameSync(src, dst); moved += 1; }
          catch (err) {
            if (!err || err.code === 'ENOENT') continue;
            failure = err; throw err;
          }
        }
      }
      for (const m of _scanDir(_archiveDir(workingDir))) {
        if (m.phase !== taskId) continue;
        const src = m.__path;
        const dst = path.join(targetDir, m.id + '.json');
        try { fs.renameSync(src, dst); moved += 1; }
        catch (err) {
          if (!err || err.code === 'ENOENT') continue;
          failure = err; throw err;
        }
      }
    } finally {
      if (moved > 0) {
        const event = {
          event: 'task-swept',
          task_id: taskId,
          moved,
          created_at: new Date().toISOString(),
          run_id: _runId(),
        };
        if (failure) {
          event.partial = true;
          event.failed_after = moved;
          event.cause = (failure && failure.code) || 'unknown';
        }
        try { appendJsonl(_manifestPath(workingDir), event, { lock: false }); }
        catch { /* swallow inside finally — original failure (if any) wins */ }
      }
    }
    return moved;
  });
}

module.exports = {
  send,
  inbox,
  archive,
  thread,
  pendingReplies,
  sweepTaskOnCommit,
  KIND_ENUM,
  AGENT_RE,
  ID_RE,
  MAX_BODY_BYTES,
};

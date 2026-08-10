'use strict';

// Session handoff document (ADR-0025).
//
// Distinct from lib/handoff.cjs, which is agent-to-agent messaging under
// ADR-0015. This is the *session* boundary artefact: what the next session — or
// a different operator — reads before touching code.
//
// The problem it solves is not "context was lost", it is "context was kept in
// the wrong shape". A conversation summary preserves the structure of the
// conversation alongside its conclusions, so discarded approaches, refuted
// assumptions and debugging detours survive as apparently-live options. The
// next session then re-attempts what this session already disproved.
//
// Six sections, and the fifth is the one that carries the value:
//   1. goal              — why this project exists, in a few sentences
//   2. status            — one line: running | partial | blocked
//   3. active_files      — only the paths that matter, each with its purpose
//   4. changes           — what was built or modified, and why
//   5. failed_approaches — what was abandoned and what made it fail
//   6. next_steps        — ordered, with a concrete re-entry command
//
// Section 5 is mandatory. It is the section every handoff format omits, and the
// only one that cannot be reconstructed from git: a commit records what worked,
// never what was tried and reverted. Skipping it is therefore not a stylistic
// choice, it is the discard of the session's most expensive finding. An empty
// list is accepted only against an explicit recorded reason — deny-by-default,
// the same shape as the archive classifier's --allow-unknown.
//
// Why this is not covered by what already exists:
//   * pause-work stamps STATE.session.stopped_at and a checkpoint pointer. That
//     resumes a *task*; it says nothing about the reasoning around it.
//   * session-report aggregates metrics since the last pointer. Backward-looking
//     accounting, not a forward-looking re-entry brief.
//   * the learnings store captures {pattern, outcome} from a turn *diff*, so an
//     approach abandoned before it was committed is invisible to it. This file
//     is where those become outcome: failed candidates.

const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteFileSync, withFileLock, projectStateDir, NubosPilotError,
} = require('./core.cjs');

const SCHEMA_VERSION = 1;

const VALID_STATUSES = Object.freeze(['running', 'partial', 'blocked']);

// The six sections, in the order they are rendered. Order is not cosmetic: goal
// and status first means a reader who stops after ten lines still knows where
// the project stands.
const SECTIONS = Object.freeze([
  'goal', 'status', 'active_files', 'changes', 'failed_approaches', 'next_steps',
]);

// Learnings caps its pattern field at 4 KiB; stay well inside it so a long
// approach description degrades to a refusal here rather than a throw there.
const MAX_PATTERN_CHARS = 2000;

// The re-entry summary the next session must produce before it touches code.
// Two lines is not a summary; six is the handoff again.
const MIN_ACK_LINES = 2;
const MAX_ACK_LINES = 6;

const RESUME_BASENAME = 'RESUME.md';
const STATE_BASENAME = 'session-handoff.json';
const ARCHIVE_DIRNAME = 'handoffs-session';

// Values that must never be written into a handoff. Names are fine and
// encouraged ("set STRIPE_SECRET_KEY"); values are the leak. Each pattern is a
// shape that is a secret regardless of the key it sits under, so this catches
// the case where the author invents a key name we do not know.
const SECRET_VALUE_PATTERNS = Object.freeze([
  { code: 'private-key-block', re: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/ },
  { code: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { code: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { code: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: 'jwt', re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { code: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/i },
  { code: 'url-embedded-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  // An assignment to a secret-ish name whose right-hand side is a real value.
  // Deliberately narrow: it fires on `TOKEN=abc123def456…`, not on prose that
  // merely mentions the variable, and not on an explicitly empty assignment.
  {
    code: 'assigned-secret-value',
    re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}["']?/,
  },
]);

function _err(code, message, details) {
  return new NubosPilotError(code, message, details || {});
}

// Single source for the learnings pattern text, so the length validated in
// validateDoc is exactly the length toLearningCandidates emits. Two spellings of
// this string is how the cap drifts away from what it guards.
// "avoid" rather than "do not", because an approach is naturally written as a
// gerund ("storing the token on the user row") and "do not storing" is not
// English. `avoid` reads correctly against both a gerund and a noun phrase,
// which keeps the store's imperative-rule convention intact.
function _candidatePattern(fa) {
  return 'avoid ' + String(fa.approach).trim().replace(/^(?:do not|don't|never|avoid)\s+/i, '')
    + ' — ' + String(fa.why_failed).trim();
}

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

let _lastTs = 0;
function _isoZ() {
  // Monotonic within a process so two handoffs in the same millisecond do not
  // collide on the archive filename.
  const now = Date.now();
  const adjusted = now > _lastTs ? now : _lastTs + 1;
  _lastTs = adjusted;
  return new Date(adjusted).toISOString();
}

function _stateRoot(cwd) {
  return projectStateDir(cwd || process.cwd());
}

function resumePath(cwd) {
  return path.join(_stateRoot(cwd), RESUME_BASENAME);
}

function statePath(cwd) {
  return path.join(_stateRoot(cwd), 'state', STATE_BASENAME);
}

function archiveDir(cwd) {
  return path.join(_stateRoot(cwd), ARCHIVE_DIRNAME);
}

/**
 * Scan every string a handoff would persist for secret *values*.
 * Returns findings rather than throwing so a caller can report all of them.
 *
 * @param {object} doc
 * @returns {{path: string, code: string}[]}
 */
function scanForSecrets(doc) {
  const findings = [];
  const visit = (value, where) => {
    if (typeof value === 'string') {
      for (const { code, re } of SECRET_VALUE_PATTERNS) {
        if (re.test(value)) findings.push({ path: where, code });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, where + '[' + i + ']'));
      return;
    }
    if (_isPlainObject(value)) {
      for (const k of Object.keys(value)) visit(value[k], where ? where + '.' + k : k);
    }
  };
  visit(doc, '');
  return findings;
}

function _assertText(value, field, minLen, id) {
  if (typeof value !== 'string' || value.trim().length < minLen) {
    throw _err(
      'session-handoff-thin-' + field.replace(/[^a-z]+/gi, '-').toLowerCase(),
      field + ' must be a string of at least ' + minLen + ' characters',
      { field, got: typeof value === 'string' ? value.trim().length : null, id },
    );
  }
}

/**
 * Validate a handoff document. Throws on the first defect.
 *
 * @param {object} doc
 * @returns {object} frozen doc
 */
function validateDoc(doc) {
  if (!_isPlainObject(doc)) {
    throw _err('session-handoff-not-object', 'A session handoff must be an object', {});
  }

  _assertText(doc.goal, 'goal', 40, undefined);

  if (!VALID_STATUSES.includes(doc.status)) {
    throw _err(
      'session-handoff-bad-status',
      'status must be one of ' + VALID_STATUSES.join(' | ') + ' (got ' + JSON.stringify(doc.status) + ')',
      { status: doc.status, allowed: VALID_STATUSES },
    );
  }

  if (!Array.isArray(doc.active_files) || doc.active_files.length === 0) {
    throw _err(
      'session-handoff-no-active-files',
      'active_files must name at least one path — a handoff with no files does not orient anyone',
      {},
    );
  }
  for (const f of doc.active_files) {
    if (!_isPlainObject(f) || typeof f.path !== 'string' || !f.path.trim()) {
      throw _err('session-handoff-bad-active-file', 'each active_files entry needs a `path`', {});
    }
    if (typeof f.purpose !== 'string' || f.purpose.trim().length < 8) {
      throw _err(
        'session-handoff-active-file-no-purpose',
        'active_files entry ' + JSON.stringify(f.path) + ' needs a `purpose` — a bare path list is a directory listing',
        { path: f.path },
      );
    }
  }

  if (!Array.isArray(doc.changes) || doc.changes.length === 0) {
    throw _err('session-handoff-no-changes', 'changes must record at least one entry', {});
  }
  for (const c of doc.changes) {
    if (!_isPlainObject(c) || typeof c.what !== 'string' || c.what.trim().length < 8) {
      throw _err('session-handoff-bad-change', 'each changes entry needs a `what`', {});
    }
    if (typeof c.why !== 'string' || c.why.trim().length < 8) {
      throw _err(
        'session-handoff-change-no-why',
        'change ' + JSON.stringify(c.what.slice(0, 40)) + ' needs a `why` — the reason is what survives; the diff already has the what',
        {},
      );
    }
  }

  // --- Section 5. The whole point of the format. ---
  if (!Array.isArray(doc.failed_approaches)) {
    throw _err(
      'session-handoff-missing-failed-approaches',
      'failed_approaches is mandatory. It is the one section git cannot reconstruct — a commit records what '
      + 'worked, never what was tried and reverted. Omitting it hands the next session a clean slate on which '
      + 'it will re-attempt what this session already disproved.',
      { section: 'failed_approaches' },
    );
  }
  if (doc.failed_approaches.length === 0) {
    // Accepted, but only on the record. Silence and "nothing failed" must not
    // be the same value on disk.
    if (typeof doc.no_failed_approaches_reason !== 'string'
        || doc.no_failed_approaches_reason.trim().length < 20) {
      throw _err(
        'session-handoff-unexplained-empty-failed-approaches',
        'An empty failed_approaches list needs an explicit no_failed_approaches_reason (>=20 chars). '
        + 'A session where genuinely nothing was abandoned is possible and unremarkable; a session that '
        + 'skipped the section is the common case. These must not look identical on disk.',
        {},
      );
    }
  }
  for (const fa of doc.failed_approaches) {
    if (!_isPlainObject(fa) || typeof fa.approach !== 'string' || fa.approach.trim().length < 12) {
      throw _err(
        'session-handoff-bad-failed-approach',
        'each failed_approaches entry needs an `approach` describing what was tried',
        {},
      );
    }
    if (typeof fa.why_failed !== 'string' || fa.why_failed.trim().length < 12) {
      throw _err(
        'session-handoff-failed-approach-no-cause',
        'failed approach ' + JSON.stringify(fa.approach.slice(0, 40)) + ' needs `why_failed`. Without the cause '
        + 'it reads as an untried option and invites a retry, which is the exact failure this section prevents.',
        {},
      );
    }
    // Cap what actually reaches the store: toLearningCandidates concatenates
    // approach AND why_failed into one pattern, so capping only the approach
    // would let a long cause blow the 4 KiB limit inside logLearning — a throw
    // at write time, far from the field that caused it.
    if (_candidatePattern(fa).length > MAX_PATTERN_CHARS) {
      throw _err(
        'session-handoff-failed-approach-too-long',
        'approach plus why_failed exceeds ' + MAX_PATTERN_CHARS + ' characters. Both are concatenated into the '
        + 'learnings pattern, so the pair has to fit the store cap — shorten whichever is padding.',
        {
          approach_length: fa.approach.length,
          why_failed_length: fa.why_failed.length,
          combined: _candidatePattern(fa).length,
          max: MAX_PATTERN_CHARS,
        },
      );
    }
  }

  if (!Array.isArray(doc.next_steps) || doc.next_steps.length === 0) {
    throw _err('session-handoff-no-next-steps', 'next_steps must list at least one ordered step', {});
  }
  for (const s of doc.next_steps) {
    if (!_isPlainObject(s) || typeof s.step !== 'string' || s.step.trim().length < 8) {
      throw _err('session-handoff-bad-next-step', 'each next_steps entry needs a `step`', {});
    }
    if (s.command !== undefined && (typeof s.command !== 'string' || !s.command.trim())) {
      throw _err('session-handoff-bad-next-step-command', '`command` must be a non-empty string when present', {});
    }
  }
  if (!doc.next_steps.some((s) => typeof s.command === 'string' && s.command.trim())) {
    throw _err(
      'session-handoff-no-reentry-command',
      'at least one next step must carry a concrete `command` — "continue the work" is not a re-entry point',
      {},
    );
  }

  const secrets = scanForSecrets(doc);
  if (secrets.length) {
    throw _err(
      'session-handoff-secret-value',
      'The handoff contains what looks like a secret value. Record the variable NAME, never the value: '
      + secrets.map((s) => s.code + ' at ' + (s.path || '<root>')).join('; '),
      { findings: secrets },
    );
  }

  return Object.freeze(doc);
}

/**
 * Render the human-facing RESUME.md. This is what the next session reads, so it
 * leads with the frontmatter a tool can parse and then the six sections in
 * order.
 */
function renderMarkdown(doc, meta) {
  validateDoc(doc);
  const m = meta || {};
  const createdAt = m.created_at || _isoZ();
  const out = [];
  out.push('---');
  out.push('schema_version: ' + SCHEMA_VERSION);
  out.push('created_at: ' + JSON.stringify(createdAt));
  out.push('status: ' + JSON.stringify(doc.status));
  out.push('milestone: ' + (m.milestone ? JSON.stringify(m.milestone) : 'null'));
  out.push('task: ' + (m.task ? JSON.stringify(m.task) : 'null'));
  out.push('read_at: ' + (m.read_at ? JSON.stringify(m.read_at) : 'null'));
  out.push('---');
  out.push('');
  out.push('# Session handoff');
  out.push('');
  out.push('> Read this before touching code. `/np:resume-work` will ask you to');
  out.push('> summarise it in a few lines first — that acknowledgement is what');
  out.push('> stops the next session re-deriving what this one already settled.');
  out.push('');

  out.push('## 1. Goal');
  out.push('');
  out.push(doc.goal.trim());
  out.push('');

  out.push('## 2. Status');
  out.push('');
  out.push('**' + doc.status + '**' + (doc.status_note ? ' — ' + String(doc.status_note).trim() : ''));
  out.push('');

  out.push('## 3. Active files');
  out.push('');
  for (const f of doc.active_files) {
    out.push('- `' + f.path.trim() + '` — ' + f.purpose.trim());
  }
  out.push('');

  out.push('## 4. Changes made');
  out.push('');
  for (const c of doc.changes) {
    out.push('- ' + c.what.trim() + ' **Why:** ' + c.why.trim());
  }
  out.push('');

  out.push('## 5. Failed approaches');
  out.push('');
  if (doc.failed_approaches.length === 0) {
    out.push('_None recorded._ ' + String(doc.no_failed_approaches_reason).trim());
  } else {
    out.push('Do not re-attempt these. Each was tried in this session and failed for the stated reason.');
    out.push('');
    for (const fa of doc.failed_approaches) {
      out.push('- **Tried:** ' + fa.approach.trim());
      out.push('  **Failed because:** ' + fa.why_failed.trim());
    }
  }
  out.push('');

  out.push('## 6. Next steps');
  out.push('');
  doc.next_steps.forEach((s, i) => {
    out.push((i + 1) + '. ' + s.step.trim());
    if (s.command && s.command.trim()) {
      out.push('   ```bash');
      out.push('   ' + s.command.trim());
      out.push('   ```');
    }
  });
  out.push('');
  return out.join('\n');
}

/**
 * Write the handoff: structured JSON as the tooling SSOT, RESUME.md for the
 * reader, plus a timestamped archive copy so history is not overwritten.
 *
 * Markdown is never parsed back — round-tripping prose is how a format starts
 * lying about its own contents.
 */
function writeHandoff(doc, cwd, meta) {
  validateDoc(doc);
  const root = _stateRoot(cwd);
  const m = meta || {};
  const createdAt = m.created_at || _isoZ();
  const record = {
    schema_version: SCHEMA_VERSION,
    created_at: createdAt,
    read_at: null,
    ack_summary: null,
    milestone: m.milestone || null,
    task: m.task || null,
    doc,
  };

  const sp = statePath(cwd);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.mkdirSync(archiveDir(cwd), { recursive: true });

  const markdown = renderMarkdown(doc, { created_at: createdAt, milestone: record.milestone, task: record.task });
  const archivePath = path.join(archiveDir(cwd), createdAt.replace(/[:.]/g, '-') + '-resume.md');

  return withFileLock(sp, () => {
    atomicWriteFileSync(sp, JSON.stringify(record, null, 2) + '\n');
    atomicWriteFileSync(path.join(root, RESUME_BASENAME), markdown);
    atomicWriteFileSync(archivePath, markdown);
    return {
      ok: true,
      created_at: createdAt,
      resume_path: path.join(root, RESUME_BASENAME),
      archive_path: archivePath,
      state_path: sp,
      failed_approaches: doc.failed_approaches.length,
    };
  });
}

/**
 * Read the current handoff record, or null when none exists.
 */
function readHandoff(cwd) {
  const sp = statePath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(sp, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw _err('session-handoff-corrupt-state', 'The handoff state file is not valid JSON', {
      path: sp, cause: err && err.message,
    });
  }
  return parsed;
}

/**
 * Acknowledge the handoff: the next session states in its own words what it
 * read. The summary is required and stored, because an ack nobody had to write
 * is a checkbox and would be clicked without reading.
 */
function ackHandoff(summary, cwd) {
  const record = readHandoff(cwd);
  if (!record) {
    throw _err('session-handoff-none', 'There is no session handoff to acknowledge', { path: statePath(cwd) });
  }
  const lines = String(summary == null ? '' : summary)
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < MIN_ACK_LINES) {
    throw _err(
      'session-handoff-ack-too-short',
      'The acknowledgement needs at least ' + MIN_ACK_LINES + ' non-empty lines summarising the handoff in your '
      + 'own words. A one-word ack is a checkbox, and a checkbox gets ticked without reading.',
      { lines: lines.length, min: MIN_ACK_LINES },
    );
  }
  if (lines.length > MAX_ACK_LINES) {
    throw _err(
      'session-handoff-ack-too-long',
      'The acknowledgement must stay under ' + MAX_ACK_LINES + ' lines — restating the handoff is not summarising it',
      { lines: lines.length, max: MAX_ACK_LINES },
    );
  }

  const sp = statePath(cwd);
  const readAt = _isoZ();
  return withFileLock(sp, () => {
    const fresh = readHandoff(cwd);
    if (!fresh) {
      throw _err('session-handoff-none', 'There is no session handoff to acknowledge', { path: sp });
    }
    fresh.read_at = readAt;
    fresh.ack_summary = lines.join('\n');
    atomicWriteFileSync(sp, JSON.stringify(fresh, null, 2) + '\n');
    // Keep RESUME.md's frontmatter honest about the ack.
    atomicWriteFileSync(
      path.join(_stateRoot(cwd), RESUME_BASENAME),
      renderMarkdown(fresh.doc, {
        created_at: fresh.created_at, milestone: fresh.milestone, task: fresh.task, read_at: readAt,
      }),
    );
    return { ok: true, read_at: readAt, lines: lines.length };
  });
}

/**
 * Gate state for /np:resume-work: is there a handoff, and has it been read?
 *
 * `gate` is the field the workflow branches on. `blocked` means an unread
 * handoff exists — proceeding would discard exactly the negative knowledge the
 * document was written to carry.
 */
function handoffStatus(cwd) {
  const record = readHandoff(cwd);
  if (!record) {
    return { exists: false, acknowledged: false, gate: 'none', resume_path: null };
  }
  const acknowledged = Boolean(record.read_at);
  return {
    exists: true,
    acknowledged,
    gate: acknowledged ? 'clear' : 'blocked',
    created_at: record.created_at,
    read_at: record.read_at || null,
    status: record.doc && record.doc.status,
    milestone: record.milestone || null,
    task: record.task || null,
    failed_approaches: (record.doc && record.doc.failed_approaches || []).length,
    resume_path: path.join(_stateRoot(cwd), RESUME_BASENAME),
  };
}

/**
 * Turn recorded failures into learnings-store candidates.
 *
 * This is the bridge that closes the gap the learnings extractor structurally
 * cannot: it reads a turn *diff*, and an approach abandoned before it was
 * committed never appears in one. Outcome is always `failed` — that is what the
 * confidence calculation demotes, so a disproved approach ranks below a proven
 * one instead of competing with it.
 *
 * Returns candidates rather than writing them: the caller decides whether this
 * project logs them, and `logLearning` is where the store's own caps live.
 */
function toLearningCandidates(doc, meta) {
  validateDoc(doc);
  const m = meta || {};
  return doc.failed_approaches.map((fa) => {
    const entry = { pattern: _candidatePattern(fa), outcome: 'failed' };
    if (m.task_id) entry.task_id = m.task_id;
    if (m.milestone_id) entry.milestone_id = m.milestone_id;
    return entry;
  });
}

module.exports = {
  SCHEMA_VERSION,
  VALID_STATUSES,
  SECTIONS,
  MAX_PATTERN_CHARS,
  MIN_ACK_LINES,
  MAX_ACK_LINES,
  RESUME_BASENAME,
  SECRET_VALUE_PATTERNS,
  resumePath,
  statePath,
  archiveDir,
  scanForSecrets,
  validateDoc,
  renderMarkdown,
  writeHandoff,
  readHandoff,
  ackHandoff,
  handoffStatus,
  toLearningCandidates,
};

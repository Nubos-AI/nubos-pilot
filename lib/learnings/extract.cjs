'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const git = require('../git.cjs');
const knowledgeAdapter = require('../knowledge-adapter.cjs');

// Stop-hook learning auto-capture (ECC continuous-learning, np-native). A
// background worker spawns the read-only np-learnings-extractor headlessly over
// the turn's diff; it returns atomic {pattern, outcome} candidates which we fold
// into the existing learnings store via the knowledge adapter — the same store
// /np:execute-phase already auto-logs into. Mirrors lib/security/review.cjs.

const EXTRACTOR_AGENT = 'np-learnings-extractor';
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_UNTRACKED_BYTES = 12 * 1024;
const MAX_CANDIDATES = 5;
const MAX_PATTERN_LEN = 2000;
const MAX_OUTCOME_LEN = 2000;
const VALID_OUTCOMES = new Set(['verified', 'failed', 'reverted', 'partial']);

function isRepo(cwd) {
  const r = git.runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.ok && String(r.stdout).trim() === 'true';
}

function _lines(stdout) {
  return String(stdout || '').split(/\r?\n/).filter(Boolean);
}

// "What changed this session": last commit (git show HEAD) plus any uncommitted
// working changes and untracked files, each capped. No baseline tracking —
// learnings are advisory, so a slightly wider window is acceptable.
function computeTurnDiff(cwd, maxFiles) {
  const cap = Number.isFinite(maxFiles) ? maxFiles : 30;
  const committedNames = git.runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD'], { cwd });
  const workingNames = git.runGit(['--no-pager', 'diff', '--name-only'], { cwd });
  const untracked = git.runGit(['ls-files', '--others', '--exclude-standard'], { cwd });

  const files = [...new Set([
    ..._lines(committedNames.stdout),
    ..._lines(workingNames.stdout),
    ..._lines(untracked.stdout),
  ])];
  const uniqueFiles = files.slice(0, cap);
  const truncatedFiles = files.length > cap;

  let diffText = '';
  const show = git.runGit(['--no-pager', 'show', '--no-color', 'HEAD'], { cwd });
  if (show.ok) diffText += String(show.stdout || '').slice(0, MAX_DIFF_BYTES);
  const working = git.runGit(['--no-pager', 'diff', '--no-color'], { cwd });
  if (working.ok && diffText.length < MAX_DIFF_BYTES) {
    diffText += '\n' + String(working.stdout || '').slice(0, MAX_DIFF_BYTES - diffText.length);
  }

  let untrackedBudget = MAX_UNTRACKED_BYTES;
  for (const f of _lines(untracked.stdout)) {
    if (untrackedBudget <= 0) break;
    let body = '';
    try { body = fs.readFileSync(path.join(cwd, f), 'utf-8'); } catch { continue; }
    const chunk = '\n--- new file: ' + f + ' ---\n' + body.slice(0, untrackedBudget);
    diffText += chunk;
    untrackedBudget -= chunk.length;
  }

  return { files: uniqueFiles, truncatedFiles, diffText };
}

function buildExtractorPrompt(opts) {
  const o = opts || {};
  const parts = [];
  parts.push('<learning_capture>');
  parts.push('You are running in learning-capture mode. Read the diff below — the work this session produced — and extract at most ' + MAX_CANDIDATES + ' ATOMIC, REUSABLE engineering learnings.');
  parts.push('');
  parts.push('A good learning is a durable, transferable rule a future agent on a SIMILAR task would benefit from — a convention discovered, a pitfall avoided, a fix that generalises. NOT a narration of what changed, NOT project-specific trivia, NOT anything obvious from reading the code.');
  parts.push('');
  parts.push('Each learning is one {pattern, outcome} pair:');
  parts.push('- pattern: the reusable rule, imperative and self-contained (e.g. "use jose for JWT verification, never hand-roll HS256").');
  parts.push('- outcome: one of verified | failed | reverted | partial — how it played out THIS session.');
  parts.push('');
  parts.push('If nothing meets the bar, return an empty list. Quality over quantity — zero is a valid, common answer.');
  parts.push('');
  parts.push('Changed files (' + o.files.length + (o.truncatedFiles ? '+, truncated' : '') + '):');
  parts.push(o.files.map((f) => '- ' + f).join('\n'));
  parts.push('');
  parts.push('Diff:');
  parts.push('```diff');
  parts.push(o.diffText);
  parts.push('```');
  parts.push('');
  parts.push('Output ONLY a single JSON object (no prose, no markdown fence):');
  parts.push('{"learnings":[{"pattern":"...","outcome":"verified|failed|reverted|partial"}]}');
  parts.push('</learning_capture>');
  return parts.join('\n');
}

function _tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }
function _stripFence(s) {
  const m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : s;
}

function parseExtractorOutput(raw) {
  if (!raw || typeof raw !== 'string') return { candidates: [], parse_ok: false };
  let resultText = raw;
  const outer = _tryParseJson(raw);
  if (outer && typeof outer === 'object' && typeof outer.result === 'string') resultText = outer.result;

  let env = _tryParseJson(resultText);
  if (!env) env = _tryParseJson(_stripFence(resultText));
  if (!env || typeof env !== 'object' || !Array.isArray(env.learnings)) {
    return { candidates: [], parse_ok: false };
  }
  const candidates = env.learnings
    .filter((l) => l && typeof l === 'object' && typeof l.pattern === 'string' && l.pattern.trim())
    .map((l) => ({
      pattern: l.pattern.trim().slice(0, MAX_PATTERN_LEN),
      outcome: VALID_OUTCOMES.has(String(l.outcome)) ? String(l.outcome) : 'verified',
    }))
    .slice(0, MAX_CANDIDATES);
  return { candidates, parse_ok: true };
}

async function _defaultSpawn(promptText, opts) {
  const spawnHeadless = require('../../bin/np-tools/spawn-headless.cjs');
  const tmp = os.tmpdir();
  const tag = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const promptPath = path.join(tmp, 'np-learn-prompt-' + tag + '.txt');
  const outputPath = path.join(tmp, 'np-learn-out-' + tag + '.json');
  fs.writeFileSync(promptPath, promptText, 'utf-8');
  try {
    await spawnHeadless.run(
      ['--agent', EXTRACTOR_AGENT, '--prompt-path', promptPath, '--output-path', outputPath,
        '--timeout-ms', String(opts.timeoutMs)],
      { cwd: opts.cwd, stdout: { write: () => {} } },
    );
    return fs.readFileSync(outputPath, 'utf-8');
  } finally {
    try { fs.unlinkSync(promptPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

async function runExtract(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const config = o.config || {};
  const spawn = typeof o.spawnImpl === 'function' ? o.spawnImpl : _defaultSpawn;
  const logImpl = typeof o.logImpl === 'function'
    ? o.logImpl
    : (cand) => knowledgeAdapter.getAdapter(cwd).log({ pattern: cand.pattern, outcome: cand.outcome });

  if (!isRepo(cwd)) return { ran: false, reason: 'not-a-repo', logged: 0 };

  const maxFiles = Number.isFinite(config.max_files) ? config.max_files : 30;
  const diff = computeTurnDiff(cwd, maxFiles);
  if (!String(diff.diffText).trim()) {
    return { ran: true, logged: 0, reason: 'empty-diff' };
  }

  const promptText = buildExtractorPrompt(diff);
  let raw = '';
  try {
    raw = await spawn(promptText, { cwd, timeoutMs: config.timeout_ms || 120000 });
  } catch {
    return { ran: true, logged: 0, reason: 'spawn-failed' };
  }

  const parsed = parseExtractorOutput(raw);
  if (!parsed.parse_ok) return { ran: true, logged: 0, reason: 'parse-failed' };

  let logged = 0;
  for (const cand of parsed.candidates) {
    try { logImpl(cand); logged += 1; } catch { /* one bad candidate must not abort the rest */ }
  }
  return { ran: true, logged, candidates: parsed.candidates.length, reason: 'ok' };
}

module.exports = {
  EXTRACTOR_AGENT,
  isRepo,
  computeTurnDiff,
  buildExtractorPrompt,
  parseExtractorOutput,
  runExtract,
  MAX_CANDIDATES,
  VALID_OUTCOMES,
};

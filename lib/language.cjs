'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot, NubosPilotError } = require('./core.cjs');

const LANG_DIRECTIVES = {
  de: 'Sprache: **Deutsch.** Jede nubos-pilot Slash-Command-Ausgabe, jede Frage an den User und jedes Statusupdate in allen `/np:*` Workflows ist auf Deutsch zu schreiben — inklusive Fehlermeldungen und Klärungsfragen. Nur Code, Bash-Kommandos, Tool-Outputs und Commit-Messages bleiben wie sie sind.',
  en: 'Language: **English.** All `/np:*` slash-command output, askuser prompts and status updates respond in English.',
};

const DEFAULT_LANGUAGE = 'en';

function normalizeLanguage(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s || DEFAULT_LANGUAGE;
}

function buildDirective(language) {
  const lang = normalizeLanguage(language);
  if (LANG_DIRECTIVES[lang]) return LANG_DIRECTIVES[lang];
  return 'Language: respond in the ISO-639 language `' + lang + '` for all `/np:*` slash-command output, askuser prompts and status updates.';
}

function readConfigLanguage(cwd) {
  let root;
  try {
    root = findProjectRoot(cwd || process.cwd());
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    throw err;
  }
  const p = path.join(root, '.nubos-pilot', 'config.json');
  if (!fs.existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new NubosPilotError('language-config-parse-error', 'config.json invalid JSON', { cause: err && err.message });
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed.response_language;
  if (raw == null || raw === '') return null;
  return normalizeLanguage(raw);
}

function resolveLanguage(cwd) {
  return readConfigLanguage(cwd) || DEFAULT_LANGUAGE;
}

function resolveDirective(cwd) {
  return buildDirective(resolveLanguage(cwd));
}

module.exports = {
  LANG_DIRECTIVES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  buildDirective,
  readConfigLanguage,
  resolveLanguage,
  resolveDirective,
};

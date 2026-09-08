'use strict';

const { readConfigGraceful } = require('./config.cjs');

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
  const parsed = readConfigGraceful(cwd, 'language-config-parse-error');
  if (!parsed) return null;
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

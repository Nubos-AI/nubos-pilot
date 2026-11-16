'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { projectStateDir } = require('../../lib/core.cjs');
const { indexStats, buildIndex, writeIndex } = require('../../lib/knowledge.cjs');
const { resolveLanguage } = require('../../lib/language.cjs');

const TOKENS_PER_BYTE = 0.27;

const LABELS = Object.freeze({
  en: {
    title: '## Context Stats',
    knowledge_h: '### Knowledge Index',
    groups_h: '### Documents by Group',
    files: 'files',
    chunks: 'chunks',
    bytes: 'bytes',
    tokens_est: 'est. tokens',
    total: 'Total',
    no_index: '_No knowledge-index. Run `/np:knowledge` to build it._',
    built_at: 'Built at',
    cols: '| Group | Files | Bytes | Est. tokens |',
    sep:  '|-------|-------|-------|-------------|',
  },
  de: {
    title: '## Context-Stats',
    knowledge_h: '### Knowledge-Index',
    groups_h: '### Dokumente pro Gruppe',
    files: 'Dateien',
    chunks: 'Chunks',
    bytes: 'Bytes',
    tokens_est: 'Tokens (geschätzt)',
    total: 'Gesamt',
    no_index: '_Kein Knowledge-Index vorhanden. Mit `/np:knowledge` erzeugen._',
    built_at: 'Gebaut am',
    cols: '| Gruppe | Dateien | Bytes | Tokens (geschätzt) |',
    sep:  '|--------|---------|-------|---------------------|',
  },
});

function _formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

function _estimateTokens(bytes) {
  return Math.round(bytes * TOKENS_PER_BYTE);
}

function _renderJson(stats, cwd) {
  return {
    schema_version: 1,
    state_dir: projectStateDir(cwd),
    knowledge: stats,
  };
}

function _renderMarkdown(stats, lang) {
  const L = LABELS[lang === 'de' ? 'de' : 'en'];
  const lines = [];
  lines.push(L.title);
  lines.push('');
  lines.push(L.knowledge_h);
  lines.push('');
  if (!stats.exists) {
    lines.push(L.no_index);
    return lines.join('\n');
  }
  lines.push('- ' + L.built_at + ': ' + stats.built_at);
  lines.push('- ' + L.files + ': ' + _formatNumber(stats.total_files));
  lines.push('- ' + L.chunks + ': ' + _formatNumber(stats.total_chunks));
  const totalBytes = Object.values(stats.groups).reduce((n, g) => n + g.bytes, 0);
  lines.push('- ' + L.bytes + ': ' + _formatNumber(totalBytes));
  lines.push('- ' + L.tokens_est + ': ' + _formatNumber(_estimateTokens(totalBytes)));
  lines.push('');
  lines.push(L.groups_h);
  lines.push('');
  lines.push(L.cols);
  lines.push(L.sep);
  const sortedGroups = Object.keys(stats.groups).sort();
  for (const g of sortedGroups) {
    const data = stats.groups[g];
    lines.push('| ' + g + ' | ' + _formatNumber(data.files)
      + ' | ' + _formatNumber(data.bytes)
      + ' | ' + _formatNumber(_estimateTokens(data.bytes)) + ' |');
  }
  lines.push('| **' + L.total + '** | **' + _formatNumber(stats.total_files)
    + '** | **' + _formatNumber(totalBytes)
    + '** | **' + _formatNumber(_estimateTokens(totalBytes)) + '** |');
  return lines.join('\n');
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const argv = args || [];
  const fmt = argv.includes('json') ? 'json' : 'markdown';

  let stats = indexStats(cwd);
  if (!stats.exists) {
    const idx = buildIndex(cwd);
    writeIndex(idx, cwd);
    stats = indexStats(cwd);
  }

  if (fmt === 'json') {
    stdout.write(JSON.stringify(_renderJson(stats, cwd)));
    return 0;
  }
  const lang = resolveLanguage(cwd);
  stdout.write(_renderMarkdown(stats, lang));
  return 0;
}

module.exports = { run, _renderMarkdown, _renderJson, _estimateTokens };

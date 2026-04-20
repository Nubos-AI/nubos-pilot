const fs = require('node:fs');
const path = require('node:path');

const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.hh': 'cpp',
  '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang',
  '.scala': 'scala',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.sql': 'sql',
  '.vue': 'vue', '.svelte': 'svelte',
  '.html': 'html', '.css': 'css', '.scss': 'css', '.less': 'css',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.md': 'markdown',
});

const NON_CODE_EXTS = new Set([
  '.md', '.json', '.yaml', '.yml', '.toml', '.lock',
  '.txt', '.log', '.csv', '.tsv',
  '.html', '.css', '.scss', '.less',
]);

const SYMBOL_PATTERNS = {
  javascript: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s*\{\s*([^}]+)\s*\}/,
    /^\s*module\.exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/,
    /^\s*exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/,
  ],
  typescript: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s*\{\s*([^}]+)\s*\}/,
  ],
  python: [
    /^def\s+([A-Za-z_][\w]*)\s*\(/,
    /^class\s+([A-Za-z_][\w]*)\s*[:(]/,
    /^async\s+def\s+([A-Za-z_][\w]*)\s*\(/,
  ],
  go: [
    /^func\s+(?:\([^)]+\)\s+)?([A-Z][\w]*)/,
    /^type\s+([A-Z][\w]*)\s+/,
    /^(?:var|const)\s+([A-Z][\w]*)/,
  ],
  rust: [
    /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
    /^\s*pub\s+(?:struct|enum|trait|mod|const|static|type)\s+([A-Za-z_][\w]*)/,
  ],
  php: [
    /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/,
    /^\s*interface\s+([A-Za-z_][\w]*)/,
    /^\s*trait\s+([A-Za-z_][\w]*)/,
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][\w]*)/,
    /^\s*namespace\s+([A-Za-z_\\][\w\\]*)/,
  ],
  ruby: [
    /^\s*class\s+([A-Z][\w]*)/,
    /^\s*module\s+([A-Z][\w]*)/,
    /^\s*def\s+(?:self\.)?([a-z_][\w]*[?!=]?)/,
  ],
  java: [
    /^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)/,
    /^\s*package\s+([\w.]+)/,
  ],
  kotlin: [
    /^\s*(?:public\s+|internal\s+|private\s+)?(?:abstract\s+|open\s+|final\s+)?(?:class|interface|object|data\s+class)\s+([A-Za-z_][\w]*)/,
    /^\s*fun\s+([A-Za-z_][\w]*)/,
  ],
  csharp: [
    /^\s*(?:public\s+|internal\s+|protected\s+|private\s+)?(?:abstract\s+|sealed\s+|static\s+)?(?:class|interface|struct|enum|record)\s+([A-Za-z_][\w]*)/,
    /^\s*namespace\s+([\w.]+)/,
  ],
  swift: [
    /^\s*(?:public\s+|open\s+|internal\s+)?(?:class|struct|enum|protocol|actor)\s+([A-Za-z_][\w]*)/,
    /^\s*(?:public\s+|open\s+|internal\s+)?func\s+([A-Za-z_][\w]*)/,
  ],
};

const IMPORT_PATTERNS = {
  javascript: [
    /^\s*import\s+(?:[^'"`]+\s+from\s+)?['"`]([^'"`]+)['"`]/,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
  ],
  typescript: [
    /^\s*import\s+(?:[^'"`]+\s+from\s+)?['"`]([^'"`]+)['"`]/,
    /^\s*import\s+type\s+[^'"`]+from\s+['"`]([^'"`]+)['"`]/,
  ],
  python: [
    /^(?:from\s+([\w.]+)\s+import)/,
    /^import\s+([\w.]+)/,
  ],
  go: [
    /^\s*import\s+"([^"]+)"/,
    /^\s*"([^"]+)"/,
  ],
  rust: [
    /^\s*use\s+([\w:]+)/,
  ],
  php: [
    /^\s*use\s+([\w\\]+)/,
    /^\s*require(?:_once)?\s+['"]([^'"]+)['"]/,
    /^\s*include(?:_once)?\s+['"]([^'"]+)['"]/,
  ],
  ruby: [
    /^\s*require\s+['"]([^'"]+)['"]/,
    /^\s*require_relative\s+['"]([^'"]+)['"]/,
  ],
  java: [
    /^\s*import\s+([\w.]+);/,
  ],
  kotlin: [
    /^\s*import\s+([\w.]+)/,
  ],
  csharp: [
    /^\s*using\s+([\w.]+);/,
  ],
  swift: [
    /^\s*import\s+([\w.]+)/,
  ],
};

function languageForExt(ext) {
  return LANGUAGE_BY_EXT[ext] || 'unknown';
}

function isCodeExt(ext) {
  if (!ext) return false;
  if (NON_CODE_EXTS.has(ext)) return false;
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXT, ext);
}

function _moduleIdFromDir(dir) {
  if (!dir || dir === '.' || dir === '') return 'root';
  return dir.replace(/\//g, '-').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
}

function groupFilesIntoModules(files) {
  const codeFiles = files.filter((f) => isCodeExt(f.ext));
  const byDir = new Map();
  for (const f of codeFiles) {
    const dir = path.posix.dirname(f.path);
    const key = dir === '.' ? '' : dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(f);
  }

  const modules = [];
  for (const [dir, members] of byDir.entries()) {
    const langCounts = {};
    for (const f of members) {
      const lang = languageForExt(f.ext);
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    const primaryLanguage = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0][0];
    const paths = members.map((m) => m.path).sort();
    modules.push({
      id: _moduleIdFromDir(dir),
      name: dir === '' ? 'root' : dir,
      directory: dir,
      primary_language: primaryLanguage,
      language_distribution: langCounts,
      source_paths: paths,
      file_count: members.length,
    });
  }

  modules.sort((a, b) => a.directory.localeCompare(b.directory));
  return modules;
}

function _readFirstLines(absPath, maxLines) {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    return raw.split(/\r?\n/).slice(0, maxLines);
  } catch {
    return [];
  }
}

function extractSymbols(absPath, language) {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return [];
  const lines = _readFirstLines(absPath, 2000);
  const syms = new Set();
  for (const line of lines) {
    for (const pat of patterns) {
      const match = line.match(pat);
      if (match && match[1]) {
        const raw = match[1].trim();
        if (raw.includes(',')) {
          for (const part of raw.split(',')) {
            const clean = part.trim().split(/\s+as\s+/)[0].trim();
            if (clean) syms.add(clean);
          }
        } else {
          syms.add(raw);
        }
      }
    }
  }
  return Array.from(syms).sort();
}

function extractDeps(absPath, language) {
  const patterns = IMPORT_PATTERNS[language];
  if (!patterns) return [];
  const lines = _readFirstLines(absPath, 2000);
  const deps = new Set();
  let inGoImportBlock = false;
  for (const line of lines) {
    if (language === 'go') {
      if (/^\s*import\s*\(/.test(line)) { inGoImportBlock = true; continue; }
      if (inGoImportBlock && /^\s*\)/.test(line)) { inGoImportBlock = false; continue; }
      if (!inGoImportBlock && !/^\s*import\s+["']/.test(line)) continue;
    }
    for (const pat of patterns) {
      const match = line.match(pat);
      if (match && match[1]) {
        deps.add(match[1].trim());
      }
    }
  }
  return Array.from(deps).sort();
}

function buildModuleFacts(module, projectRoot) {
  const root = path.resolve(projectRoot);
  const symbols = new Set();
  const deps = new Set();
  const perFile = [];
  for (const rel of module.source_paths) {
    const abs = path.join(root, rel);
    const lang = languageForExt(path.extname(rel).toLowerCase());
    const fileSymbols = extractSymbols(abs, lang);
    const fileDeps = extractDeps(abs, lang);
    for (const s of fileSymbols) symbols.add(s);
    for (const d of fileDeps) deps.add(d);
    perFile.push({
      path: rel,
      language: lang,
      symbols: fileSymbols,
      deps: fileDeps,
    });
  }
  const internalDeps = Array.from(deps).filter((d) => d.startsWith('.') || d.startsWith('/')).sort();
  const externalDeps = Array.from(deps).filter((d) => !d.startsWith('.') && !d.startsWith('/')).sort();
  return {
    id: module.id,
    name: module.name,
    directory: module.directory,
    primary_language: module.primary_language,
    language_distribution: module.language_distribution,
    file_count: module.file_count,
    source_paths: module.source_paths,
    symbols: Array.from(symbols).sort(),
    internal_deps: internalDeps,
    external_deps: externalDeps,
    files: perFile,
  };
}

function buildDocumenterPrompt(facts) {
  const lines = [];
  lines.push('You are the np-codebase-documenter agent.');
  lines.push('Produce prose sections for the module below. Output JSON only:');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "description": "one-sentence summary",');
  lines.push('  "purpose": "2-4 sentences on why this module exists",');
  lines.push('  "key_concepts": ["bullet", "bullet"],');
  lines.push('  "public_api": "markdown describing the public surface",');
  lines.push('  "invariants": ["must-hold-true rules"],');
  lines.push('  "gotchas": ["non-obvious behaviors"]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Module facts (from deterministic parser — treat as ground truth):');
  lines.push('```json');
  lines.push(JSON.stringify(facts, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Ground every claim in the facts. Do not invent symbols or deps.');
  lines.push('- Keep prose in English.');
  lines.push('- If the module is tiny or trivial, say so — do not pad.');
  lines.push('- No marketing language.');
  return lines.join('\n');
}

function renderModuleDoc(facts, prose, sourceHashes) {
  const fm = [];
  fm.push('---');
  fm.push('name: ' + facts.name);
  fm.push('description: ' + (prose && prose.description ? _escapeYaml(prose.description) : ''));
  fm.push('kind: module');
  fm.push('module_id: ' + facts.id);
  fm.push('directory: ' + facts.directory);
  fm.push('primary_language: ' + facts.primary_language);
  fm.push('file_count: ' + facts.file_count);
  fm.push('source_paths:');
  for (const p of facts.source_paths) fm.push('  - ' + p);
  fm.push('symbols:');
  for (const s of facts.symbols) fm.push('  - ' + s);
  if (facts.external_deps.length > 0) {
    fm.push('external_deps:');
    for (const d of facts.external_deps) fm.push('  - ' + d);
  }
  if (facts.internal_deps.length > 0) {
    fm.push('internal_deps:');
    for (const d of facts.internal_deps) fm.push('  - ' + d);
  }
  fm.push('source_hashes:');
  for (const p of facts.source_paths) {
    const h = sourceHashes && sourceHashes[p] ? sourceHashes[p] : '';
    fm.push('  ' + p + ': ' + h);
  }
  fm.push('last_documented: ' + new Date().toISOString().slice(0, 10));
  fm.push('---');
  fm.push('');
  fm.push('# ' + facts.name);
  fm.push('');
  fm.push('## Purpose');
  fm.push('');
  fm.push((prose && prose.purpose) || '_TBD — run np:update-docs to populate._');
  fm.push('');
  fm.push('## Key Concepts');
  fm.push('');
  const keys = (prose && Array.isArray(prose.key_concepts)) ? prose.key_concepts : [];
  if (keys.length === 0) fm.push('_TBD_');
  else for (const k of keys) fm.push('- ' + k);
  fm.push('');
  fm.push('## Public API');
  fm.push('');
  fm.push((prose && prose.public_api) || '_TBD_');
  fm.push('');
  fm.push('## Invariants');
  fm.push('');
  const invs = (prose && Array.isArray(prose.invariants)) ? prose.invariants : [];
  if (invs.length === 0) fm.push('_None documented yet._');
  else for (const inv of invs) fm.push('- ' + inv);
  fm.push('');
  fm.push('## Gotchas');
  fm.push('');
  const got = (prose && Array.isArray(prose.gotchas)) ? prose.gotchas : [];
  if (got.length === 0) fm.push('_None documented yet._');
  else for (const g of got) fm.push('- ' + g);
  fm.push('');
  fm.push('## Files');
  fm.push('');
  for (const file of facts.files) {
    fm.push('### `' + file.path + '`');
    fm.push('');
    fm.push('- Language: ' + file.language);
    if (file.symbols.length > 0) fm.push('- Symbols: ' + file.symbols.join(', '));
    if (file.deps.length > 0) fm.push('- Deps: ' + file.deps.join(', '));
    fm.push('');
  }
  return fm.join('\n');
}

function _escapeYaml(s) {
  const str = String(s);
  if (str.includes('\n') || str.includes(':') || str.includes('#')) {
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return str;
}

function buildIndexDoc(modules, meta) {
  const lines = [];
  lines.push('<!-- Generated by np:scan-codebase / np:update-docs. Do not edit by hand. -->');
  lines.push('');
  lines.push('# Codebase Index');
  lines.push('');
  if (meta && meta.project_name) {
    lines.push('**Project:** ' + meta.project_name);
  }
  lines.push('**Generated:** ' + new Date().toISOString().slice(0, 10));
  lines.push('**Modules:** ' + modules.length);
  lines.push('');
  lines.push('> Dev-Agents MUST read this index and relevant module docs before modifying code.');
  lines.push('> After code changes, run `np:update-docs <path>` to refresh affected module docs.');
  lines.push('');
  lines.push('## Modules');
  lines.push('');
  for (const mod of modules) {
    const line = '- [`' + (mod.directory || 'root') + '`](modules/' + mod.id + '.md) — ' +
      mod.file_count + ' file' + (mod.file_count === 1 ? '' : 's') + ' · ' +
      mod.primary_language;
    lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

function moduleDocPath(projectRoot, moduleId) {
  return path.join(
    path.resolve(projectRoot),
    '.nubos-pilot',
    'codebase',
    'modules',
    moduleId + '.md',
  );
}

function indexDocPath(projectRoot) {
  return path.join(
    path.resolve(projectRoot),
    '.nubos-pilot',
    'codebase',
    'INDEX.md',
  );
}

function buildDocIndexMap(modules) {
  const index = {};
  for (const mod of modules) {
    const relDoc = path.posix.join('modules', mod.id + '.md');
    index[relDoc] = mod.source_paths.slice();
  }
  return index;
}

module.exports = {
  LANGUAGE_BY_EXT,
  languageForExt,
  isCodeExt,
  groupFilesIntoModules,
  extractSymbols,
  extractDeps,
  buildModuleFacts,
  buildDocumenterPrompt,
  renderModuleDoc,
  buildIndexDoc,
  buildDocIndexMap,
  moduleDocPath,
  indexDocPath,
};

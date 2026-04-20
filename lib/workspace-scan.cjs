const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NubosPilotError } = require('./core.cjs');

const DEFAULT_IGNORES = Object.freeze(new Set([
  'node_modules', '.git', '.nubos-pilot', '.planning', '.claude',
  'vendor', 'target', 'build', 'dist', 'out',
  '.next', '.nuxt', '.svelte-kit', '.astro',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'coverage', '.coverage', '.nyc_output', '.tox',
  '.idea', '.vscode', '.vs',
  '.cache', '.turbo', '.parcel-cache', '.gradle',
  'Pods', 'DerivedData',
  'tmp', 'temp', '.tmp',
]));

const MANIFEST_FILES = Object.freeze(new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'jsconfig.json',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock',
  'Cargo.toml', 'Cargo.lock',
  'go.mod', 'go.sum',
  'composer.json', 'composer.lock',
  'Gemfile', 'Gemfile.lock', 'Rakefile',
  'mix.exs', 'rebar.config',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'Makefile', 'CMakeLists.txt',
  '.nvmrc', '.tool-versions', '.node-version', '.python-version', '.ruby-version',
  '.env.example', '.env.sample', '.editorconfig',
]));

const DOC_FILE_PREFIXES = Object.freeze([
  'README', 'CHANGELOG', 'LICENSE', 'CONTRIBUTING',
  'ARCHITECTURE', 'ROADMAP', 'SECURITY', 'CODE_OF_CONDUCT',
  'AUTHORS', 'NOTICE', 'DESIGN',
]);

const BINARY_EXTS = Object.freeze(new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.class', '.jar', '.war', '.pyc', '.pyo',
  '.db', '.sqlite', '.sqlite3',
  '.node', '.wasm',
  '.psd', '.ai', '.sketch', '.fig',
]));

const MAX_FILE_HASH_BYTES = 512 * 1024;
const MAX_FILE_CAPTURE_BYTES = 200 * 1024;
const MAX_FILES_WALKED = 100000;
const MAX_DEPTH = 12;

function _isDocFile(basename) {
  const up = basename.toUpperCase();
  for (const prefix of DOC_FILE_PREFIXES) {
    if (up === prefix) return true;
    if (up.startsWith(prefix + '.')) return true;
  }
  return false;
}

function _isDotfileAllowed(name) {
  if (name === '.nvmrc' || name === '.tool-versions' || name === '.node-version') return true;
  if (name === '.python-version' || name === '.ruby-version') return true;
  if (name === '.env.example' || name === '.env.sample') return true;
  if (name === '.editorconfig' || name === '.gitignore' || name === '.dockerignore') return true;
  if (name === '.gitattributes') return true;
  return false;
}

function _sha256(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function _readCapture(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const toRead = Math.min(stat.size, MAX_FILE_CAPTURE_BYTES);
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) fs.readSync(fd, buf, 0, toRead, 0);
      return {
        content: buf.toString('utf-8'),
        size: stat.size,
        truncated: stat.size > toRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { error: err && err.code ? err.code : String(err) };
  }
}

function _walk(root, ignores, opts) {
  const files = [];
  const skipped = [];
  let walked = 0;

  function visit(abs, rel, depth) {
    if (walked >= opts.maxFiles) return;
    if (depth > opts.maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: rel || '.', reason: 'readdir-error', detail: err && err.code });
      return;
    }
    for (const entry of entries) {
      if (walked >= opts.maxFiles) {
        skipped.push({ path: rel, reason: 'max-files-reached' });
        return;
      }
      const name = entry.name;
      if (ignores.has(name)) continue;
      if (name.startsWith('.') && entry.isDirectory()) continue;
      if (name.startsWith('.') && entry.isFile() && !_isDotfileAllowed(name)) continue;

      const childAbs = path.join(abs, name);
      const childRel = rel === '' ? name : rel + '/' + name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(childAbs, childRel, depth + 1);
      } else if (entry.isFile()) {
        walked++;
        let stat;
        try {
          stat = fs.statSync(childAbs);
        } catch (err) {
          skipped.push({ path: childRel, reason: 'stat-error', detail: err && err.code });
          continue;
        }
        files.push({
          path: childRel,
          absPath: childAbs,
          size: stat.size,
          ext: path.extname(name).toLowerCase(),
          basename: name,
        });
      }
    }
  }

  visit(root, '', 0);
  return { files, skipped };
}

function _hashFile(file) {
  if (BINARY_EXTS.has(file.ext)) return null;
  if (file.size > MAX_FILE_HASH_BYTES) return null;
  try {
    return _sha256(fs.readFileSync(file.absPath));
  } catch {
    return null;
  }
}

function scan(opts) {
  const options = opts || {};
  const cwd = path.resolve(options.cwd || process.cwd());
  const ignores = new Set([...DEFAULT_IGNORES, ...(options.additionalIgnores || [])]);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const batchSize = options.batchSize > 0 ? options.batchSize : 500;
  const maxFiles = options.maxFiles > 0 ? options.maxFiles : MAX_FILES_WALKED;
  const maxDepth = options.maxDepth > 0 ? options.maxDepth : MAX_DEPTH;

  let rootStat;
  try {
    rootStat = fs.statSync(cwd);
  } catch (err) {
    throw new NubosPilotError(
      'scan-cwd-unreadable',
      `cannot stat cwd: ${cwd}`,
      { cwd, cause: err && err.code },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new NubosPilotError(
      'scan-not-a-directory',
      `cwd is not a directory: ${cwd}`,
      { cwd },
    );
  }

  onProgress({ phase: 'walk-start', cwd });
  const { files, skipped } = _walk(cwd, ignores, { maxFiles, maxDepth });
  onProgress({ phase: 'walk-complete', file_count: files.length, skipped: skipped.length });

  const language_distribution = {};
  const manifests = {};
  const docs = {};
  const fileHashes = [];
  let totalBytes = 0;

  const totalBatches = Math.ceil(files.length / batchSize);
  for (let i = 0; i < files.length; i += batchSize) {
    const batchIndex = Math.floor(i / batchSize);
    const batch = files.slice(i, i + batchSize);
    onProgress({
      phase: 'batch-start',
      index: batchIndex,
      total: totalBatches,
      size: batch.length,
      files_processed: i,
      files_total: files.length,
    });

    for (const f of batch) {
      totalBytes += f.size;
      const extKey = f.ext || '<no-ext>';
      language_distribution[extKey] = (language_distribution[extKey] || 0) + 1;

      const isManifest = MANIFEST_FILES.has(f.basename);
      const isDoc = _isDocFile(f.basename);
      if (isManifest || isDoc) {
        const captured = _readCapture(f.absPath);
        const entry = { path: f.path, size: f.size, ...captured };
        if (isManifest) manifests[f.path] = entry;
        else docs[f.path] = entry;
      }

      const hash = _hashFile(f);
      if (hash) {
        fileHashes.push({
          path: f.path,
          size: f.size,
          sha256: hash,
          ext: f.ext,
        });
      } else {
        skipped.push({
          path: f.path,
          reason: BINARY_EXTS.has(f.ext) ? 'binary' : f.size > MAX_FILE_HASH_BYTES ? 'too-large' : 'hash-error',
          size: f.size,
        });
      }
    }

    onProgress({
      phase: 'batch-done',
      index: batchIndex,
      total: totalBatches,
      files_processed: Math.min(i + batch.length, files.length),
      files_total: files.length,
    });
  }

  let git = { is_repo: false };
  if (typeof options.gitInfo === 'function') {
    try { git = options.gitInfo(cwd) || { is_repo: false }; }
    catch { git = { is_repo: false }; }
  }

  const result = {
    cwd,
    scanned_at: new Date().toISOString(),
    stats: {
      file_count: files.length,
      hashed_count: fileHashes.length,
      manifest_count: Object.keys(manifests).length,
      doc_count: Object.keys(docs).length,
      skipped_count: skipped.length,
      total_bytes: totalBytes,
    },
    files: fileHashes,
    manifests,
    docs,
    git,
    language_distribution,
    skipped,
  };

  onProgress({ phase: 'complete', stats: result.stats });
  return result;
}

module.exports = {
  scan,
  DEFAULT_IGNORES,
  MANIFEST_FILES,
  BINARY_EXTS,
  MAX_FILE_HASH_BYTES,
  MAX_FILE_CAPTURE_BYTES,
};

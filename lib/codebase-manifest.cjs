const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync, NubosPilotError } = require('./core.cjs');

const SCHEMA_VERSION = 1;
const CODEBASE_DIR_NAME = 'codebase';
const MANIFEST_FILENAME = '.hashes.json';

function manifestPath(projectRoot) {
  return path.join(
    path.resolve(projectRoot),
    '.nubos-pilot',
    CODEBASE_DIR_NAME,
    MANIFEST_FILENAME,
  );
}

function emptyManifest() {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: null,
    files: {},
  };
}

function readManifest(projectRoot) {
  const p = manifestPath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyManifest();
    throw new NubosPilotError(
      'manifest-read-error',
      `cannot read codebase manifest at ${p}`,
      { path: p, cause: err && err.code },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'manifest-parse-error',
      `codebase manifest is not valid JSON at ${p}`,
      { path: p, cause: err && err.message },
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new NubosPilotError(
      'manifest-invalid-shape',
      `codebase manifest root is not an object at ${p}`,
      { path: p },
    );
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new NubosPilotError(
      'manifest-schema-mismatch',
      `codebase manifest schema_version ${parsed.schema_version} does not match ${SCHEMA_VERSION}`,
      { path: p, found: parsed.schema_version, expected: SCHEMA_VERSION },
    );
  }
  if (!parsed.files || typeof parsed.files !== 'object') parsed.files = {};
  return parsed;
}

function writeManifest(projectRoot, manifest) {
  const p = manifestPath(projectRoot);
  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    files: manifest && manifest.files ? manifest.files : {},
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

function manifestFromScanFiles(scanFiles) {
  const files = {};
  for (const f of scanFiles || []) {
    if (!f || !f.path || !f.sha256) continue;
    files[f.path] = {
      sha256: f.sha256,
      size: typeof f.size === 'number' ? f.size : 0,
      ext: typeof f.ext === 'string' ? f.ext : '',
    };
  }
  return { schema_version: SCHEMA_VERSION, generated_at: null, files };
}

function diffManifest(prev, next) {
  const prevFiles = (prev && prev.files) || {};
  const nextFiles = (next && next.files) || {};
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [p, meta] of Object.entries(nextFiles)) {
    const before = prevFiles[p];
    if (!before) {
      added.push({ path: p, sha256: meta.sha256, size: meta.size, ext: meta.ext });
    } else if (before.sha256 !== meta.sha256) {
      changed.push({
        path: p,
        sha256: meta.sha256,
        prev_sha256: before.sha256,
        size: meta.size,
        ext: meta.ext,
      });
    } else {
      unchanged.push({ path: p, sha256: meta.sha256, size: meta.size, ext: meta.ext });
    }
  }
  for (const [p, meta] of Object.entries(prevFiles)) {
    if (!nextFiles[p]) {
      removed.push({ path: p, prev_sha256: meta.sha256 });
    }
  }

  added.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort((a, b) => a.path.localeCompare(b.path));
  changed.sort((a, b) => a.path.localeCompare(b.path));
  unchanged.sort((a, b) => a.path.localeCompare(b.path));

  return {
    added,
    removed,
    changed,
    unchanged,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

function stalePathsForDocs(diff, docIndex) {
  const touched = new Set();
  for (const entry of [...(diff.added || []), ...(diff.changed || []), ...(diff.removed || [])]) {
    touched.add(entry.path);
  }
  const staleDocs = new Set();
  for (const [docId, sources] of Object.entries(docIndex || {})) {
    if (!Array.isArray(sources)) continue;
    for (const src of sources) {
      if (touched.has(src)) {
        staleDocs.add(docId);
        break;
      }
    }
  }
  return {
    stale_docs: Array.from(staleDocs).sort(),
    touched_paths: Array.from(touched).sort(),
  };
}

module.exports = {
  SCHEMA_VERSION,
  manifestPath,
  emptyManifest,
  readManifest,
  writeManifest,
  manifestFromScanFiles,
  diffManifest,
  stalePathsForDocs,
};

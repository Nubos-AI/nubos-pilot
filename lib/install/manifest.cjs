const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync, NubosPilotError } = require('../core.cjs');

const MANIFEST_FILENAME = '.manifest.json';

function fileHashSync(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function buildManifest(payloadDir, pkgVersion) {
  const files = Object.create(null);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new NubosPilotError(
        'manifest-build-failed',
        'Cannot read payload directory: ' + dir,
        { dir, cause: err && err.message },
      );
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (entry.name === MANIFEST_FILENAME) continue;
      const rel = path.relative(payloadDir, full).replace(/\\/g, '/');
      files[rel] = fileHashSync(full);
    }
  }
  walk(payloadDir);
  return {
    version: String(pkgVersion == null ? '' : pkgVersion),
    timestamp: new Date().toISOString(),
    files,
  };
}

function diffManifests(oldM, newM) {
  const oldFiles = (oldM && oldM.files) || {};
  const newFiles = (newM && newM.files) || {};
  const oldKeys = Object.keys(oldFiles);
  const newKeys = Object.keys(newFiles);
  const newSet = new Set(newKeys);
  const oldSet = new Set(oldKeys);
  const stale = oldKeys.filter((k) => !newSet.has(k));
  const added = newKeys.filter((k) => !oldSet.has(k));
  const changed = newKeys.filter(
    (k) => oldSet.has(k) && oldFiles[k] !== newFiles[k],
  );
  return { stale, added, changed };
}

function _validateManifestShape(parsed, manifestPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NubosPilotError(
      'manifest-invalid-structure',
      'Manifest root must be an object',
      { path: manifestPath },
    );
  }
  const files = parsed.files;
  if (files == null || typeof files !== 'object' || Array.isArray(files)) {
    throw new NubosPilotError(
      'manifest-invalid-structure',
      'Manifest files map must be an object',
      { path: manifestPath },
    );
  }
  const safeFiles = Object.create(null);
  for (const key of Object.keys(files)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new NubosPilotError(
        'manifest-invalid-structure',
        'Refusing prototype-pollution key: ' + key,
        { path: manifestPath, key },
      );
    }
    const value = files[key];
    if (typeof value !== 'string') {
      throw new NubosPilotError(
        'manifest-invalid-structure',
        'Manifest entry must be a hash string: ' + key,
        { path: manifestPath, key },
      );
    }
    safeFiles[key] = value;
  }
  return {
    version: parsed.version == null ? '' : String(parsed.version),
    timestamp: parsed.timestamp == null ? '' : String(parsed.timestamp),
    files: safeFiles,
  };
}

function readManifest(payloadDir) {
  const manifestPath = path.join(payloadDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'manifest-parse-failed',
      'Cannot read manifest: ' + (err && err.message),
      { path: manifestPath },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'manifest-parse-failed',
      'Manifest JSON invalid: ' + (err && err.message),
      { path: manifestPath },
    );
  }
  return _validateManifestShape(parsed, manifestPath);
}

function writeManifest(payloadDir, manifest) {
  try {
    fs.mkdirSync(payloadDir, { recursive: true });
  } catch (err) {
    throw new NubosPilotError(
      'manifest-write-failed',
      'Cannot ensure payload directory: ' + (err && err.message),
      { payloadDir },
    );
  }
  const manifestPath = path.join(payloadDir, MANIFEST_FILENAME);
  const payload = JSON.stringify(manifest, null, 2);
  atomicWriteFileSync(manifestPath, payload);
}

module.exports = {
  buildManifest,
  diffManifests,
  readManifest,
  writeManifest,
  fileHashSync,
};

'use strict';

const fs = require('node:fs');
const { NubosPilotError, atomicWriteFileSync } = require('./core.cjs');

function createUsearchIndex(opts) {
  const o = opts || {};
  const dim = o.dim;
  const metric = o.metric || 'cos';
  if (typeof dim !== 'number' || dim <= 0) {
    throw new NubosPilotError('memory-invalid-dim', 'dim required as positive integer', { dim });
  }

  let usearchModule;
  try {
    usearchModule = require('usearch');
  } catch (err) {
    throw new NubosPilotError(
      'memory-usearch-not-installed',
      'usearch is not installed. Run `npm install --include=optional` to enable the HNSW index, or set memory.enabled=false in .nubos-pilot/config.json',
      { dim, metric, require_error: err && err.message },
    );
  }

  const { Index } = usearchModule;
  let idx = new Index({ metric, dimensions: dim });
  let nextKey = 1n;
  let keyToId = new Map();
  let idToKey = new Map();

  function _toId(rawKey) {
    const k = typeof rawKey === 'bigint' ? rawKey : BigInt(rawKey);
    return keyToId.get(k) || null;
  }

  return {
    dim,
    metric,
    add(id, vector) {
      if (idToKey.has(id)) {
        const existing = idToKey.get(id);
        try { idx.remove(existing); } catch {}
        keyToId.delete(existing);
      }
      const k = nextKey++;
      idx.add(k, vector);
      keyToId.set(k, id);
      idToKey.set(id, k);
    },
    remove(id) {
      const k = idToKey.get(id);
      if (k == null) return;
      try { idx.remove(k); } catch {}
      keyToId.delete(k);
      idToKey.delete(id);
    },
    size() { return keyToId.size; },
    isEmpty() { return keyToId.size === 0; },
    clear() {
      idx = new Index({ metric, dimensions: dim });
      nextKey = 1n;
      keyToId = new Map();
      idToKey = new Map();
    },
    search(vector, k) {
      if (keyToId.size === 0) return [];
      const result = idx.search(vector, k);
      const keys = result.keys || [];
      const distances = result.distances || [];
      const out = [];
      for (let i = 0; i < keys.length; i++) {
        const id = _toId(keys[i]);
        if (!id) continue;
        const distance = Number(distances[i]);
        const score = metric === 'cos' ? 1 - distance : -distance;
        out.push({ id, score });
      }
      return out;
    },
    saveSync(filePath) {
      const mapPath = filePath + '.keymap.json';
      const dump = {};
      for (const [k, id] of keyToId.entries()) dump[k.toString()] = id;
      const tmp = filePath + '.tmp';
      idx.save(tmp);
      if (fs.existsSync(filePath)) {
        try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* best-effort */ }
      }
      fs.renameSync(tmp, filePath);
      atomicWriteFileSync(mapPath, JSON.stringify(dump));
    },
    loadSync(filePath) {
      idx.load(filePath);
      const mapPath = filePath + '.keymap.json';
      if (!fs.existsSync(mapPath)) {
        throw new NubosPilotError(
          'memory-index-desync',
          'usearch index loaded but its keymap is missing — index/keymap pair is inconsistent',
          { indexPath: filePath, keymapPath: mapPath, hint: 'run `memory-rebuild` to repair.' },
        );
      }
      let dump;
      try { dump = JSON.parse(fs.readFileSync(mapPath, 'utf-8')); }
      catch (err) {
        throw new NubosPilotError(
          'memory-index-keymap-corrupt',
          'usearch keymap is not valid JSON: ' + (err && err.message),
          { keymapPath: mapPath, hint: 'run `memory-rebuild` to repair.' },
        );
      }
      if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
        throw new NubosPilotError(
          'memory-index-keymap-corrupt',
          'usearch keymap is not a JSON object',
          { keymapPath: mapPath },
        );
      }
      keyToId = new Map();
      idToKey = new Map();
      let maxKey = 0n;
      for (const [kStr, id] of Object.entries(dump)) {
        if (!/^[0-9]+$/.test(kStr) || typeof id !== 'string') continue;
        const k = BigInt(kStr);
        keyToId.set(k, id);
        idToKey.set(id, k);
        if (k > maxKey) maxKey = k;
      }
      nextKey = maxKey + 1n;
      let indexSize = null;
      try { indexSize = typeof idx.size === 'function' ? Number(idx.size()) : null; } catch {}
      if (indexSize != null && Number.isFinite(indexSize) && indexSize !== keyToId.size) {
        throw new NubosPilotError(
          'memory-index-desync',
          `usearch index has ${indexSize} vectors but keymap has ${keyToId.size} entries`,
          { indexPath: filePath, keymapPath: mapPath, indexSize, keymapSize: keyToId.size, hint: 'run `memory-rebuild` to repair.' },
        );
      }
    },
  };
}

module.exports = { createUsearchIndex };

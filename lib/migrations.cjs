'use strict';

const { NubosPilotError } = require('./core.cjs');


function _migrationKey(kind, from, to) {
  return kind + ':' + from + '->' + to;
}

class MigrationRegistry {
  constructor() {
    this._byKind = new Map();
  }

  register(kind, from, to, transform) {
    if (typeof kind !== 'string' || !kind) {
      throw new NubosPilotError('migration-invalid-kind', 'kind must be non-empty string', { kind });
    }
    if (!Number.isInteger(from) || from < 1) {
      throw new NubosPilotError('migration-invalid-from', 'from must be positive integer', { from });
    }
    if (!Number.isInteger(to) || to !== from + 1) {
      throw new NubosPilotError(
        'migration-invalid-step',
        'migrations must be single-step (from+1 → to); got ' + from + ' → ' + to,
        { from, to },
      );
    }
    if (typeof transform !== 'function') {
      throw new NubosPilotError('migration-invalid-transform', 'transform must be a function', { kind });
    }
    if (!this._byKind.has(kind)) this._byKind.set(kind, new Map());
    const map = this._byKind.get(kind);
    const key = _migrationKey(kind, from, to);
    if (map.has(key)) {
      throw new NubosPilotError(
        'migration-duplicate',
        'migration already registered: ' + key,
        { kind, from, to },
      );
    }
    map.set(key, transform);
  }

  run(kind, doc, fromVersion, toVersion) {
    if (fromVersion === toVersion) return doc;
    if (fromVersion > toVersion) {
      throw new NubosPilotError(
        'migration-downgrade-unsupported',
        'no downgrade path: ' + kind + ' ' + fromVersion + ' → ' + toVersion,
        { kind, fromVersion, toVersion },
      );
    }
    const map = this._byKind.get(kind);
    if (!map) {
      throw new NubosPilotError(
        'migration-no-path',
        'no migrations registered for kind ' + kind,
        { kind },
      );
    }
    let current = doc;
    for (let v = fromVersion; v < toVersion; v += 1) {
      const key = _migrationKey(kind, v, v + 1);
      const step = map.get(key);
      if (!step) {
        throw new NubosPilotError(
          'migration-missing-step',
          'no migration registered for step ' + key,
          { kind, missingStep: v + '->' + (v + 1) },
        );
      }
      current = step(current);
    }
    return current;
  }

  has(kind, from, to) {
    const map = this._byKind.get(kind);
    return !!(map && map.has(_migrationKey(kind, from, to)));
  }
}

const registry = new MigrationRegistry();

module.exports = {
  MigrationRegistry,
  registry,
};

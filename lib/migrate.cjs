'use strict';

const { assertValid } = require('./validate.cjs');

const MAX_HOPS = 100;

function runMigrators(obj, opts) {
  const o = opts || {};
  const versionField = o.versionField || 'version';
  const target = o.targetVersion;
  const migrators = o.migrators || {};
  let cur = obj;
  let hops = 0;
  while (cur && typeof cur === 'object' && !Array.isArray(cur) && cur[versionField] !== target) {
    if (hops >= MAX_HOPS) return null;
    hops += 1;
    const key = cur[versionField];
    if (!Object.prototype.hasOwnProperty.call(migrators, key)) return null;
    const fn = migrators[key];
    if (typeof fn !== 'function') return null;
    cur = fn(cur);
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
  if (o.schema) assertValid(cur, o.schema, o.code || 'data-migration-invalid', o.details || {});
  return cur;
}

module.exports = { runMigrators, MAX_HOPS };

'use strict';

const crypto = require('node:crypto');

const { NubosPilotError } = require('../../core.cjs');

const SPEC_VERSION = '1.6';
const BOM_FORMAT = 'CycloneDX';
const TOOL_NAME = 'nubos-pilot';

const CDX_SCOPE = Object.freeze({
  prod: 'required',
  optional: 'optional',
  dev: 'excluded',
  unknown: 'required',
});

const SPDX_ID_RE = /^[A-Za-z0-9.+-]+$/;

function _serialNumber(components) {
  const digest = crypto.createHash('sha256')
    .update(components.map((c) => c['bom-ref']).join('\n'))
    .digest();
  const hex = digest.subarray(0, 16).toString('hex').split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return 'urn:uuid:' + [
    s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20, 32),
  ].join('-');
}

function _licenses(license) {
  if (typeof license !== 'string' || !license) return null;
  const parts = license.split(/\s+OR\s+/i).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((id) => (SPDX_ID_RE.test(id)
    ? { license: { id } }
    : { license: { name: id } }));
}

function _component(pkg) {
  const component = {
    type: 'library',
    'bom-ref': pkg.purl,
    name: pkg.name,
    purl: pkg.purl,
    scope: CDX_SCOPE[pkg.scope] || CDX_SCOPE.unknown,
  };
  if (pkg.version) component.version = pkg.version;
  const licenses = _licenses(pkg.license);
  if (licenses) component.licenses = licenses;
  component.properties = [
    { name: 'nubos-pilot:ecosystem', value: pkg.ecosystem },
    { name: 'nubos-pilot:scope', value: pkg.scope },
    { name: 'nubos-pilot:direct', value: String(pkg.direct === true) },
  ];
  if (pkg.source) {
    component.properties.push({ name: 'nubos-pilot:source', value: pkg.source });
  }
  return component;
}

function toCycloneDx(inventory, opts) {
  const o = opts || {};
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.packages)) {
    throw new NubosPilotError(
      'sbom-invalid-inventory',
      'toCycloneDx requires an inventory with a packages array',
      { got: inventory === null ? 'null' : typeof inventory },
    );
  }
  if (typeof o.timestamp !== 'string' || !o.timestamp) {
    throw new NubosPilotError(
      'sbom-missing-timestamp',
      'toCycloneDx requires an explicit ISO timestamp so the export stays reproducible',
      {},
    );
  }

  const components = inventory.packages
    .filter((p) => p && p.purl)
    .map(_component)
    .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

  const rootName = typeof o.projectName === 'string' && o.projectName ? o.projectName : 'unnamed-project';
  const bom = {
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber: _serialNumber(components),
    version: 1,
    metadata: {
      timestamp: o.timestamp,
      tools: {
        components: [{
          type: 'application',
          name: TOOL_NAME,
          version: typeof o.toolVersion === 'string' && o.toolVersion ? o.toolVersion : '0.0.0',
        }],
      },
      component: {
        type: 'application',
        'bom-ref': 'root',
        name: rootName,
      },
    },
    components,
  };
  if (typeof o.projectVersion === 'string' && o.projectVersion) {
    bom.metadata.component.version = o.projectVersion;
  }
  return bom;
}

function render(inventory, opts) {
  return JSON.stringify(toCycloneDx(inventory, opts), null, 2) + '\n';
}

module.exports = {
  SPEC_VERSION,
  BOM_FORMAT,
  CDX_SCOPE,
  toCycloneDx,
  render,
};

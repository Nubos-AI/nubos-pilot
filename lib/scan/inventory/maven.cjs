'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');

const FILES = Object.freeze(['pom.xml']);

const ECOSYSTEM = 'Maven';

const IGNORED_ELEMENTS = Object.freeze([
  'dependencyManagement',
  'build',
  'reporting',
  'pluginManagement',
  'plugins',
  'plugin',
]);

const MAX_PROPERTY_PASSES = 8;

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function elementPattern(tag, flags) {
  return new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', flags);
}

function stripElement(xml, tag) {
  return xml.replace(elementPattern(tag, 'g'), '');
}

function tagValue(block, tag) {
  const match = elementPattern(tag, '').exec(block);
  return match ? match[1].trim() : null;
}

function readProperties(xml) {
  const properties = new Map();
  const blocks = xml.matchAll(elementPattern('properties', 'g'));
  for (const block of blocks) {
    const entries = block[1].matchAll(/<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g);
    for (const entry of entries) properties.set(entry[1], entry[2].trim());
  }
  return properties;
}

function resolveVersion(raw, properties) {
  let value = raw;
  for (let pass = 0; pass < MAX_PROPERTY_PASSES && value.includes('${'); pass += 1) {
    const next = value.replace(/\$\{([^}]*)\}/g, (whole, key) => (
      properties.has(key) ? properties.get(key) : whole
    ));
    if (next === value) break;
    value = next;
  }
  return value.includes('${') ? null : value.trim() || null;
}

function mapScope(scope, optional) {
  if (optional === 'true') return 'optional';
  if (scope === 'test' || scope === 'provided' || scope === 'system') return 'dev';
  return 'prod';
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  if (path.basename(file) !== 'pom.xml') return { packages: [], warnings: ['unsupported-file'] };

  const text = typeof content === 'string' ? content : String(content == null ? '' : content);
  const warnings = [];
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const properties = readProperties(withoutComments);

  let scannable = withoutComments;
  for (const tag of IGNORED_ELEMENTS) scannable = stripElement(scannable, tag);

  const packages = [];
  for (const block of scannable.matchAll(elementPattern('dependency', 'g'))) {
    const body = stripElement(block[1], 'exclusions');
    const groupId = tagValue(body, 'groupId');
    const artifactId = tagValue(body, 'artifactId');
    if (!groupId || !artifactId) {
      warn(warnings, 'malformed-dependency');
      continue;
    }

    const declared = tagValue(body, 'version');
    const version = declared ? resolveVersion(declared, properties) : null;
    if (!version) warn(warnings, 'unresolved-version');

    const optional = (tagValue(body, 'optional') || '').toLowerCase();
    const scope = (tagValue(body, 'scope') || '').toLowerCase();

    try {
      packages.push(makePackage({
        ecosystem: ECOSYSTEM,
        name: groupId + ':' + artifactId,
        version,
        scope: mapScope(scope, optional),
        direct: true,
        source: file || null,
      }));
    } catch {
      warn(warnings, 'invalid-package');
    }
  }
  return { packages, warnings };
}

module.exports = { FILES, parse };

'use strict';

const finding = require('../../finding.cjs');
const { parseHcl } = require('./parse.cjs');

const RULES = Object.freeze({
  S3_PUBLIC_ACCESS_BLOCK: Object.freeze({
    id: 'NPS-0670',
    rule_name: 's3_public_access_block_disabled',
    category: 'public-exposure',
    severity: 'high',
    cwe: ['CWE-732'],
    reminder: 'This bucket opts out of an S3 public-access guard. Set every block_* and restrict_* flag to true unless the bucket is deliberately a public website.',
  }),
  S3_PUBLIC_ACL: Object.freeze({
    id: 'NPS-0671',
    rule_name: 's3_public_acl',
    category: 'public-exposure',
    severity: 'high',
    cwe: ['CWE-732'],
    reminder: 'A public-read ACL exposes bucket contents to anyone on the internet. Use a private ACL and grant access through a bucket policy or a signed URL.',
  }),
  S3_UNENCRYPTED: Object.freeze({
    id: 'NPS-0672',
    rule_name: 's3_bucket_unencrypted',
    category: 'encryption',
    severity: 'medium',
    cwe: ['CWE-311'],
    reminder: 'Declare an aws_s3_bucket_server_side_encryption_configuration for this bucket so objects are encrypted at rest with a known key.',
  }),
  SECURITY_GROUP_OPEN: Object.freeze({
    id: 'NPS-0673',
    rule_name: 'security_group_open_to_world',
    category: 'public-exposure',
    severity: 'high',
    cwe: ['CWE-284'],
    reminder: 'This ingress rule accepts traffic from every address on the internet. Narrow cidr_blocks to the networks that need it, or front the service with a load balancer.',
  }),
  STORAGE_UNENCRYPTED: Object.freeze({
    id: 'NPS-0674',
    rule_name: 'unencrypted_storage',
    category: 'encryption',
    severity: 'high',
    cwe: ['CWE-311'],
    reminder: 'Encryption at rest is off or unset for this volume or database. Set encrypted/storage_encrypted to true; on an existing resource this needs a rebuild or a snapshot restore.',
  }),
  DATABASE_PUBLIC: Object.freeze({
    id: 'NPS-0675',
    rule_name: 'database_publicly_accessible',
    category: 'public-exposure',
    severity: 'critical',
    cwe: ['CWE-284'],
    reminder: 'This database gets a public endpoint. Set publicly_accessible = false and reach it from inside the VPC or through a bastion.',
  }),
  HARDCODED_CREDENTIAL: Object.freeze({
    id: 'NPS-0676',
    rule_name: 'hardcoded_credential',
    category: 'hardcoded-secret',
    severity: 'critical',
    cwe: ['CWE-798'],
    reminder: 'A credential is committed in Terraform source and is also written to state. Move it to a secret manager or a variable, and rotate the exposed credential.',
  }),
  IAM_UNRESTRICTED: Object.freeze({
    id: 'NPS-0677',
    rule_name: 'iam_policy_unrestricted',
    category: 'excessive-privilege',
    severity: 'high',
    cwe: ['CWE-732'],
    reminder: 'This policy allows every action on every resource. Enumerate the actions and ARNs the principal actually needs.',
  }),
  MISSING_LOGGING: Object.freeze({
    id: 'NPS-0678',
    rule_name: 'missing_logging',
    category: 'observability',
    severity: 'low',
    cwe: ['CWE-778'],
    reminder: 'Without access logging there is no record of who reached this resource. Add the matching logging configuration and keep the log target out of the audited bucket.',
  }),
  UNEVALUABLE: Object.freeze({
    id: 'NPS-0679',
    rule_name: 'unevaluable_value',
    category: 'scan-coverage',
    severity: 'low',
    reminder: 'This value is a variable, interpolation, function call or count/for_each expression, so its security-relevant setting could not be decided from source alone. Review it by hand; this is a coverage gap, not a pass.',
  }),
});

const FILES = Object.freeze(['*.tf']);

const TF_FILE_RE = /\.tf$/i;
const BUCKET_TYPE = 'aws_s3_bucket';
const SSE_TYPE = 'aws_s3_bucket_server_side_encryption_configuration';
const BUCKET_LOGGING_TYPE = 'aws_s3_bucket_logging';
const PUBLIC_ACCESS_BLOCK_TYPE = 'aws_s3_bucket_public_access_block';
const PUBLIC_ACCESS_KEYS = Object.freeze([
  'block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets',
]);
const PUBLIC_ACLS = Object.freeze(['public-read', 'public-read-write']);
const ACL_TYPES = Object.freeze(['aws_s3_bucket_acl', BUCKET_TYPE]);
const OPEN_CIDRS = Object.freeze(['0.0.0.0/0', '::/0']);
const ADMIN_PORTS = Object.freeze([22, 3389]);
const ALL_PROTOCOLS = Object.freeze(['-1', 'all']);
const SG_TYPE = 'aws_security_group';
const SG_RULE_TYPE = 'aws_security_group_rule';
const VPC_INGRESS_RULE_TYPE = 'aws_vpc_security_group_ingress_rule';
const ENCRYPTION_ATTRIBUTE = Object.freeze({
  aws_ebs_volume: 'encrypted',
  aws_rds_cluster: 'storage_encrypted',
  aws_db_instance: 'storage_encrypted',
});
const DB_INSTANCE_TYPE = 'aws_db_instance';
const CLOUDTRAIL_TYPE = 'aws_cloudtrail';
const POLICY_TYPES = Object.freeze([
  'aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_user_policy', 'aws_iam_group_policy',
  'aws_iam_role', 'aws_s3_bucket_policy',
]);
const POLICY_ATTRIBUTES = Object.freeze(['policy', 'assume_role_policy']);
const POLICY_DATA_TYPE = 'aws_iam_policy_document';
const CREDENTIAL_KEY_RE = /^(?:password|.*_password|secret_key|secret_access_key|access_key)$/i;
const WILDCARD_ACTION_RE = /"Action"\s*:\s*(?:\[\s*)?"\*"/i;
const WILDCARD_RESOURCE_RE = /"Resource"\s*:\s*(?:\[\s*)?"\*"/i;
const BUCKET_REFERENCE_RE = /\baws_s3_bucket\.([A-Za-z0-9_-]+)/g;
const MIN_CREDENTIAL_LENGTH = 4;
const UNCERTAIN_SUFFIX = ' (a companion resource in this file targets a bucket this scan could not resolve, so it may already cover this one)';

function matches(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  const base = relPath.split(/[\\/]/).pop();
  if (!base || base.startsWith('.')) return false;
  return TF_FILE_RE.test(base);
}

function _isUnresolved(value) {
  return !!value && typeof value === 'object' && value.unresolved === true;
}

function _hasUnresolved(value) {
  if (_isUnresolved(value)) return true;
  return Array.isArray(value) && value.some(_isUnresolved);
}

function _label(resource) {
  return resource.type + (resource.name ? '.' + resource.name : '');
}

function _finding(rule, ctx, line, title, severity) {
  return finding.make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: 'misconfig',
    category: rule.category,
    severity: severity || rule.severity,
    cwe: rule.cwe || [],
    file: ctx.file,
    line,
    title,
    reminder: rule.reminder,
  });
}

function _report(ctx, rule, line, title, severity) {
  ctx.findings.push(_finding(rule, ctx, line, title, severity));
}

function _unevaluable(ctx, resource, attribute, reason) {
  const key = resource.block.line + ':' + attribute;
  if (ctx.unevaluable.has(key)) return;
  ctx.unevaluable.add(key);
  _report(ctx, RULES.UNEVALUABLE, resource.block.line,
    _label(resource) + ' ' + attribute + ' could not be evaluated (' + reason + ')');
}

function _constructOf(value) {
  if (_isUnresolved(value)) return value.construct;
  if (Array.isArray(value)) {
    const found = value.find(_isUnresolved);
    if (found) return found.construct;
  }
  return 'unresolved';
}

function _resources(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type !== 'resource' && block.type !== 'data') continue;
    out.push({ kind: block.type, type: block.labels[0] || '', name: block.labels[1] || '', block });
  }
  return out;
}

function _ofType(resources, kind, type) {
  return resources.filter((r) => r.kind === kind && r.type === type);
}

function _linkedBucketNames(resource, buckets) {
  const value = resource.block.attributes.bucket;
  const names = new Set();
  if (typeof value === 'string') {
    for (const bucket of buckets) {
      if (bucket.name === value || bucket.block.attributes.bucket === value) names.add(bucket.name);
    }
  } else if (_isUnresolved(value) && typeof value.raw === 'string') {
    BUCKET_REFERENCE_RE.lastIndex = 0;
    let m = BUCKET_REFERENCE_RE.exec(value.raw);
    while (m) {
      names.add(m[1]);
      m = BUCKET_REFERENCE_RE.exec(value.raw);
    }
  }
  if (!names.size && buckets.some((bucket) => bucket.name === resource.name)) names.add(resource.name);
  return names;
}

function _bucketCoverage(ctx, buckets, companionType, nestedBlockType) {
  const covered = new Set();
  let unlinkable = false;
  for (const companion of _ofType(ctx.resources, 'resource', companionType)) {
    const names = _linkedBucketNames(companion, buckets);
    if (!names.size) {
      unlinkable = true;
      _unevaluable(ctx, companion, 'bucket', _constructOf(companion.block.attributes.bucket));
      continue;
    }
    for (const name of names) covered.add(name);
  }
  for (const bucket of buckets) {
    if (bucket.block.blocks.some((nested) => nested.type === nestedBlockType)) covered.add(bucket.name);
  }
  return { covered, unlinkable, uncertain: unlinkable ? UNCERTAIN_SUFFIX : '' };
}

function _checkPublicAccessBlock(ctx) {
  for (const resource of _ofType(ctx.resources, 'resource', PUBLIC_ACCESS_BLOCK_TYPE)) {
    const attrs = resource.block.attributes;
    const disabled = [];
    for (const key of PUBLIC_ACCESS_KEYS) {
      if (attrs[key] === false) disabled.push(key);
      else if (_isUnresolved(attrs[key])) _unevaluable(ctx, resource, key, _constructOf(attrs[key]));
    }
    if (disabled.length) {
      _report(ctx, RULES.S3_PUBLIC_ACCESS_BLOCK, resource.block.line,
        _label(resource) + ' disables ' + disabled.join(', '));
    }
  }
}

function _checkPublicAcl(ctx) {
  for (const resource of ctx.resources) {
    if (resource.kind !== 'resource' || !ACL_TYPES.includes(resource.type)) continue;
    const acl = resource.block.attributes.acl;
    if (_isUnresolved(acl)) { _unevaluable(ctx, resource, 'acl', _constructOf(acl)); continue; }
    if (typeof acl !== 'string') continue;
    if (!PUBLIC_ACLS.includes(acl.toLowerCase())) continue;
    _report(ctx, RULES.S3_PUBLIC_ACL, resource.block.line,
      _label(resource) + ' grants acl = "' + acl + '"');
  }
}

function _checkBucketEncryption(ctx, buckets) {
  const coverage = _bucketCoverage(ctx, buckets, SSE_TYPE, 'server_side_encryption_configuration');
  for (const bucket of buckets) {
    if (coverage.covered.has(bucket.name)) continue;
    _report(ctx, RULES.S3_UNENCRYPTED, bucket.block.line,
      _label(bucket) + ' has no server-side encryption configuration' + coverage.uncertain);
  }
}

function _checkBucketLogging(ctx, buckets) {
  const coverage = _bucketCoverage(ctx, buckets, BUCKET_LOGGING_TYPE, 'logging');
  for (const bucket of buckets) {
    if (coverage.covered.has(bucket.name)) continue;
    _report(ctx, RULES.MISSING_LOGGING, bucket.block.line,
      _label(bucket) + ' has no access logging configuration' + coverage.uncertain);
  }
  for (const trail of _ofType(ctx.resources, 'resource', CLOUDTRAIL_TYPE)) {
    const enabled = trail.block.attributes.enable_logging;
    if (_isUnresolved(enabled)) { _unevaluable(ctx, trail, 'enable_logging', _constructOf(enabled)); continue; }
    if (enabled === false) {
      _report(ctx, RULES.MISSING_LOGGING, trail.block.line, _label(trail) + ' sets enable_logging = false');
    }
  }
}

function _openCidrs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && OPEN_CIDRS.includes(entry.trim()));
}

function _coversAdminPort(attrs) {
  const protocol = attrs.protocol;
  if (typeof protocol === 'string' && ALL_PROTOCOLS.includes(protocol.toLowerCase())) return true;
  const from = attrs.from_port;
  const to = attrs.to_port;
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (from === 0 && to === 0) return true;
  return ADMIN_PORTS.some((port) => from <= port && to >= port);
}

function _reportOpenIngress(ctx, resource, block, cidrs) {
  const admin = _coversAdminPort(block.attributes);
  if (admin === null) _unevaluable(ctx, resource, 'from_port/to_port', _constructOf(block.attributes.from_port));
  _report(ctx, RULES.SECURITY_GROUP_OPEN, block.line,
    _label(resource) + ' ingress allows ' + cidrs.join(', ') + (admin ? ' to an administrative port' : ''),
    admin ? 'critical' : 'high');
}

function _ingressCidrAttributes(attrs) {
  const values = [];
  for (const key of ['cidr_blocks', 'ipv6_cidr_blocks', 'cidr_ipv4', 'cidr_ipv6']) {
    if (attrs[key] === undefined) continue;
    values.push({ key, value: typeof attrs[key] === 'string' ? [attrs[key]] : attrs[key] });
  }
  return values;
}

function _checkIngress(ctx, resource, block) {
  const attributes = _ingressCidrAttributes(block.attributes);
  const open = [];
  for (const entry of attributes) {
    if (_hasUnresolved(entry.value)) {
      _unevaluable(ctx, resource, entry.key, _constructOf(entry.value));
      continue;
    }
    for (const cidr of _openCidrs(entry.value)) open.push(cidr);
  }
  if (open.length) _reportOpenIngress(ctx, resource, block, open);
}

function _checkSecurityGroups(ctx) {
  for (const resource of _ofType(ctx.resources, 'resource', SG_TYPE)) {
    for (const nested of resource.block.blocks) {
      if (nested.type === 'ingress') _checkIngress(ctx, resource, nested);
    }
  }
  for (const resource of _ofType(ctx.resources, 'resource', SG_RULE_TYPE)) {
    const type = resource.block.attributes.type;
    if (_isUnresolved(type)) { _unevaluable(ctx, resource, 'type', _constructOf(type)); continue; }
    if (type !== 'ingress') continue;
    _checkIngress(ctx, resource, resource.block);
  }
  for (const resource of _ofType(ctx.resources, 'resource', VPC_INGRESS_RULE_TYPE)) {
    _checkIngress(ctx, resource, resource.block);
  }
}

function _checkStorageEncryption(ctx) {
  for (const resource of ctx.resources) {
    if (resource.kind !== 'resource') continue;
    const attribute = ENCRYPTION_ATTRIBUTE[resource.type];
    if (!attribute) continue;
    const value = resource.block.attributes[attribute];
    if (_isUnresolved(value)) { _unevaluable(ctx, resource, attribute, _constructOf(value)); continue; }
    if (value === true) continue;
    _report(ctx, RULES.STORAGE_UNENCRYPTED, resource.block.line,
      _label(resource) + ' has ' + attribute + (value === false ? ' = false' : ' unset'));
  }
}

function _checkPublicDatabase(ctx) {
  for (const resource of _ofType(ctx.resources, 'resource', DB_INSTANCE_TYPE)) {
    const value = resource.block.attributes.publicly_accessible;
    if (_isUnresolved(value)) { _unevaluable(ctx, resource, 'publicly_accessible', _constructOf(value)); continue; }
    if (value !== true) continue;
    _report(ctx, RULES.DATABASE_PUBLIC, resource.block.line,
      _label(resource) + ' sets publicly_accessible = true');
  }
}

function _credentialFindings(ctx, block, path) {
  for (const [key, value] of Object.entries(block.attributes)) {
    if (!CREDENTIAL_KEY_RE.test(key)) continue;
    if (typeof value !== 'string' || value.trim().length < MIN_CREDENTIAL_LENGTH) continue;
    _report(ctx, RULES.HARDCODED_CREDENTIAL, block.line,
      path + ' sets ' + key + ' to a literal value (redacted)');
  }
  for (const nested of block.blocks) {
    _credentialFindings(ctx, nested, path + '.' + nested.type);
  }
}

function _checkCredentials(ctx) {
  for (const block of ctx.blocks) {
    const path = [block.type].concat(block.labels).join('.');
    _credentialFindings(ctx, block, path);
  }
}

function _wildcard(value) {
  if (value === '*') return true;
  return Array.isArray(value) && value.some((entry) => entry === '*');
}

function _documentIsUnrestricted(document) {
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement];
  for (const statement of statements) {
    if (!statement || typeof statement !== 'object') continue;
    if (typeof statement.Effect === 'string' && statement.Effect.toLowerCase() === 'deny') continue;
    if (_wildcard(statement.Action) && _wildcard(statement.Resource)) return true;
  }
  return false;
}

function _policyIsUnrestricted(text) {
  let document = null;
  try { document = JSON.parse(text); } catch { document = null; }
  if (document && typeof document === 'object') return _documentIsUnrestricted(document);
  return WILDCARD_ACTION_RE.test(text) && WILDCARD_RESOURCE_RE.test(text);
}

function _checkPolicyDocuments(ctx) {
  for (const resource of ctx.resources) {
    if (resource.kind === 'resource' && POLICY_TYPES.includes(resource.type)) {
      for (const attribute of POLICY_ATTRIBUTES) {
        const value = resource.block.attributes[attribute];
        if (value === undefined) continue;
        if (_isUnresolved(value)) { _unevaluable(ctx, resource, attribute, _constructOf(value)); continue; }
        if (typeof value !== 'string' || !_policyIsUnrestricted(value)) continue;
        _report(ctx, RULES.IAM_UNRESTRICTED, resource.block.line,
          _label(resource) + ' ' + attribute + ' allows "*" on "*"');
      }
      continue;
    }
    if (resource.kind !== 'data' || resource.type !== POLICY_DATA_TYPE) continue;
    for (const statement of resource.block.blocks) {
      if (statement.type !== 'statement') continue;
      const attrs = statement.attributes;
      if (typeof attrs.effect === 'string' && attrs.effect.toLowerCase() === 'deny') continue;
      if (_hasUnresolved(attrs.actions) || _hasUnresolved(attrs.resources)) {
        _unevaluable(ctx, resource, 'statement', _constructOf(attrs.actions));
        continue;
      }
      if (!_wildcard(attrs.actions) || !_wildcard(attrs.resources)) continue;
      _report(ctx, RULES.IAM_UNRESTRICTED, statement.line,
        _label(resource) + ' statement allows "*" on "*"');
    }
  }
}

function check(content, opts) {
  const o = opts || {};
  if (content != null && typeof content !== 'string') {
    return { findings: [], warnings: ['invalid-input'] };
  }
  const parsed = parseHcl(content);
  const ctx = {
    file: typeof o.file === 'string' && o.file ? o.file : null,
    blocks: parsed.blocks,
    resources: _resources(parsed.blocks),
    findings: [],
    warnings: parsed.warnings.slice(),
    unevaluable: new Set(),
  };
  const buckets = _ofType(ctx.resources, 'resource', BUCKET_TYPE);

  _checkPublicAccessBlock(ctx);
  _checkPublicAcl(ctx);
  _checkBucketEncryption(ctx, buckets);
  _checkSecurityGroups(ctx);
  _checkStorageEncryption(ctx);
  _checkPublicDatabase(ctx);
  _checkCredentials(ctx);
  _checkPolicyDocuments(ctx);
  _checkBucketLogging(ctx, buckets);

  return { findings: ctx.findings, warnings: ctx.warnings };
}

module.exports = { RULES, FILES, matches, check };

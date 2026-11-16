'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, FILES, matches, check } = require('./rules.cjs');
const { idInRange, SEVERITIES } = require('../../finding.cjs');
const { NubosPilotError } = require('../../../core.cjs');

function tf(lines) {
  return check(lines.join('\n'), { file: 'infra/main.tf' });
}

function byRule(findings, rule) {
  return findings.filter((f) => f.id === rule.id);
}

function ids(findings) {
  return findings.map((f) => f.id).join(',');
}

test('TF-1 matches accepts .tf and rejects .tfvars, .tf.json and state files', () => {
  for (const accepted of ['main.tf', 'infra/prod/main.tf', 'variables.tf', 'override.tf', 'MAIN.TF']) {
    assert.equal(matches(accepted), true, accepted + ' should match');
  }
  for (const rejected of [
    'terraform.tfvars',
    'prod.auto.tfvars',
    'main.tf.json',
    'terraform.tfstate',
    'main.tfbackup',
    'README.md',
    '.terraform.lock.hcl',
    '',
    null,
  ]) {
    assert.equal(matches(rejected), false, String(rejected) + ' should not match');
  }
  assert.deepEqual(FILES, ['*.tf']);
});

test('TF-2 a public access block that opts out is flagged; all-true is clean', () => {
  const open = tf([
    'resource "aws_s3_bucket_public_access_block" "b" {',
    '  bucket                  = aws_s3_bucket.b.id',
    '  block_public_acls       = false',
    '  block_public_policy     = true',
    '  ignore_public_acls      = true',
    '  restrict_public_buckets = false',
    '}',
  ]);
  const flagged = byRule(open.findings, RULES.S3_PUBLIC_ACCESS_BLOCK);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'high');
  assert.equal(flagged[0].line, 1);
  assert.match(flagged[0].title, /block_public_acls, restrict_public_buckets/);

  const locked = tf([
    'resource "aws_s3_bucket_public_access_block" "b" {',
    '  bucket                  = aws_s3_bucket.b.id',
    '  block_public_acls       = true',
    '  block_public_policy     = true',
    '  ignore_public_acls      = true',
    '  restrict_public_buckets = true',
    '}',
  ]);
  assert.deepEqual(byRule(locked.findings, RULES.S3_PUBLIC_ACCESS_BLOCK), []);
});

test('TF-3 a public-read ACL is flagged and a private ACL is not', () => {
  const open = tf([
    'resource "aws_s3_bucket_acl" "assets" {',
    '  bucket = aws_s3_bucket.assets.id',
    '  acl    = "public-read"',
    '}',
    '',
    'resource "aws_s3_bucket_acl" "logs" {',
    '  bucket = aws_s3_bucket.logs.id',
    '  acl    = "public-read-write"',
    '}',
  ]);
  const flagged = byRule(open.findings, RULES.S3_PUBLIC_ACL);
  assert.equal(flagged.length, 2);
  assert.equal(flagged[0].severity, 'high');

  const closed = tf([
    'resource "aws_s3_bucket_acl" "assets" {',
    '  bucket = aws_s3_bucket.assets.id',
    '  acl    = "private"',
    '}',
  ]);
  assert.deepEqual(byRule(closed.findings, RULES.S3_PUBLIC_ACL), []);
});

test('TF-4 a bucket without a server-side encryption configuration is flagged', () => {
  const bare = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
  ]);
  const flagged = byRule(bare.findings, RULES.S3_UNENCRYPTED);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'medium');
  assert.equal(flagged[0].line, 1);

  const linkedByReference = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
    '',
    'resource "aws_s3_bucket_server_side_encryption_configuration" "data" {',
    '  bucket = aws_s3_bucket.data.id',
    '',
    '  rule {',
    '    apply_server_side_encryption_by_default {',
    '      sse_algorithm = "aws:kms"',
    '    }',
    '  }',
    '}',
  ]);
  assert.deepEqual(byRule(linkedByReference.findings, RULES.S3_UNENCRYPTED), []);

  const inlineLegacy = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '',
    '  server_side_encryption_configuration {',
    '    rule {',
    '      apply_server_side_encryption_by_default {',
    '        sse_algorithm = "AES256"',
    '      }',
    '    }',
    '  }',
    '}',
  ]);
  assert.deepEqual(byRule(inlineLegacy.findings, RULES.S3_UNENCRYPTED), []);
});

test('TF-5 world-open ingress is critical on admin ports and high otherwise', () => {
  const { findings } = tf([
    'resource "aws_security_group" "web" {',
    '  name = "web"',
    '',
    '  ingress {',
    '    from_port   = 22',
    '    to_port     = 22',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["0.0.0.0/0"]',
    '  }',
    '',
    '  ingress {',
    '    from_port   = 443',
    '    to_port     = 443',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["0.0.0.0/0"]',
    '  }',
    '',
    '  ingress {',
    '    from_port        = 8080',
    '    to_port          = 8080',
    '    protocol         = "tcp"',
    '    ipv6_cidr_blocks = ["::/0"]',
    '  }',
    '',
    '  ingress {',
    '    from_port   = 5432',
    '    to_port     = 5432',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["10.0.0.0/8", "192.168.0.0/16"]',
    '  }',
    '',
    '  egress {',
    '    from_port   = 0',
    '    to_port     = 0',
    '    protocol    = "-1"',
    '    cidr_blocks = ["0.0.0.0/0"]',
    '  }',
    '}',
  ]);
  const open = byRule(findings, RULES.SECURITY_GROUP_OPEN);
  assert.equal(open.length, 3, 'egress and the private range must not be flagged: ' + ids(findings));
  assert.equal(open[0].severity, 'critical');
  assert.equal(open[0].line, 4);
  assert.match(open[0].title, /administrative port/);
  assert.equal(open[1].severity, 'high');
  assert.equal(open[2].severity, 'high');
  assert.match(open[2].title, /::\/0/);
});

test('TF-6 a standalone ingress rule open to the world is flagged, egress is not', () => {
  const ingress = tf([
    'resource "aws_security_group_rule" "rdp" {',
    '  type              = "ingress"',
    '  from_port         = 3389',
    '  to_port           = 3389',
    '  protocol          = "tcp"',
    '  cidr_blocks       = ["0.0.0.0/0"]',
    '  security_group_id = "sg-1"',
    '}',
  ]);
  const flagged = byRule(ingress.findings, RULES.SECURITY_GROUP_OPEN);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'critical');

  const egress = tf([
    'resource "aws_security_group_rule" "out" {',
    '  type              = "egress"',
    '  from_port         = 0',
    '  to_port           = 0',
    '  protocol          = "-1"',
    '  cidr_blocks       = ["0.0.0.0/0"]',
    '  security_group_id = "sg-1"',
    '}',
  ]);
  assert.deepEqual(byRule(egress.findings, RULES.SECURITY_GROUP_OPEN), []);

  const allPorts = tf([
    'resource "aws_vpc_security_group_ingress_rule" "any" {',
    '  security_group_id = "sg-1"',
    '  cidr_ipv4         = "0.0.0.0/0"',
    '  ip_protocol       = "-1"',
    '  from_port         = 0',
    '  to_port           = 0',
    '}',
  ]);
  assert.equal(byRule(allPorts.findings, RULES.SECURITY_GROUP_OPEN)[0].severity, 'critical');
});

test('TF-7 storage with encryption off or unset is flagged, encrypted storage is not', () => {
  const bad = tf([
    'resource "aws_ebs_volume" "data" {',
    '  availability_zone = "eu-central-1a"',
    '  size              = 40',
    '  encrypted         = false',
    '}',
    '',
    'resource "aws_rds_cluster" "main" {',
    '  cluster_identifier = "main"',
    '}',
  ]);
  const flagged = byRule(bad.findings, RULES.STORAGE_UNENCRYPTED);
  assert.equal(flagged.length, 2);
  assert.equal(flagged[0].severity, 'high');
  assert.match(flagged[0].title, /encrypted = false/);
  assert.match(flagged[1].title, /storage_encrypted unset/);

  const good = tf([
    'resource "aws_ebs_volume" "data" {',
    '  size      = 40',
    '  encrypted = true',
    '}',
    '',
    'resource "aws_db_instance" "main" {',
    '  identifier          = "main"',
    '  storage_encrypted   = true',
    '  publicly_accessible = false',
    '}',
  ]);
  assert.deepEqual(byRule(good.findings, RULES.STORAGE_UNENCRYPTED), []);
});

test('TF-8 a publicly accessible database is critical; a private one is clean', () => {
  const open = tf([
    'resource "aws_db_instance" "main" {',
    '  identifier          = "main"',
    '  storage_encrypted   = true',
    '  publicly_accessible = true',
    '}',
  ]);
  const flagged = byRule(open.findings, RULES.DATABASE_PUBLIC);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'critical');

  const closed = tf([
    'resource "aws_db_instance" "main" {',
    '  identifier          = "main"',
    '  storage_encrypted   = true',
    '  publicly_accessible = false',
    '}',
  ]);
  assert.deepEqual(byRule(closed.findings, RULES.DATABASE_PUBLIC), []);
});

test('TF-9 hardcoded credentials are critical and their values are redacted', () => {
  const { findings } = tf([
    'provider "aws" {',
    '  region     = "eu-central-1"',
    '  access_key = "AKIAIOSFODNN7EXAMPLE"',
    '  secret_key = "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY"',
    '}',
    '',
    'resource "aws_db_instance" "main" {',
    '  identifier        = "main"',
    '  storage_encrypted = true',
    '  password          = "correct-horse-battery-staple"',
    '}',
  ]);
  const flagged = byRule(findings, RULES.HARDCODED_CREDENTIAL);
  assert.equal(flagged.length, 3);
  for (const f of flagged) assert.equal(f.severity, 'critical');
  const serialized = JSON.stringify(findings);
  for (const secret of [
    'AKIAIOSFODNN7EXAMPLE',
    'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY',
    'correct-horse-battery-staple',
  ]) {
    assert.ok(!serialized.includes(secret), 'the value of ' + secret.slice(0, 6) + '... must be redacted');
  }

  const fromVariables = tf([
    'provider "aws" {',
    '  region     = "eu-central-1"',
    '  access_key = var.access_key',
    '  secret_key = var.secret_key',
    '}',
    '',
    'resource "aws_db_instance" "main" {',
    '  identifier        = "main"',
    '  storage_encrypted = true',
    '  password          = random_password.db.result',
    '}',
  ]);
  assert.deepEqual(byRule(fromVariables.findings, RULES.HARDCODED_CREDENTIAL), [],
    'a non-literal credential is exactly the pattern we want, so it stays silent');
});

test('TF-10 an inline policy allowing * on * is flagged; a scoped policy is not', () => {
  const wildcard = tf([
    'resource "aws_iam_role_policy" "admin" {',
    '  name = "admin"',
    '  role = "r"',
    '',
    '  policy = <<EOF',
    '{',
    '  "Version": "2012-10-17",',
    '  "Statement": [',
    '    {',
    '      "Effect": "Allow",',
    '      "Action": "*",',
    '      "Resource": "*"',
    '    }',
    '  ]',
    '}',
    'EOF',
    '}',
  ]);
  const flagged = byRule(wildcard.findings, RULES.IAM_UNRESTRICTED);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'high');

  const scoped = tf([
    'resource "aws_iam_role_policy" "reader" {',
    '  name = "reader"',
    '  role = "r"',
    '',
    '  policy = <<EOF',
    '{',
    '  "Version": "2012-10-17",',
    '  "Statement": [',
    '    {',
    '      "Effect": "Allow",',
    '      "Action": ["s3:GetObject"],',
    '      "Resource": "arn:aws:s3:::acme-data/*"',
    '    }',
    '  ]',
    '}',
    'EOF',
    '}',
  ]);
  assert.deepEqual(byRule(scoped.findings, RULES.IAM_UNRESTRICTED), []);

  const denyOnly = tf([
    'resource "aws_iam_policy" "guard" {',
    '  name   = "guard"',
    '  policy = "{\\"Statement\\":[{\\"Effect\\":\\"Deny\\",\\"Action\\":\\"*\\",\\"Resource\\":\\"*\\"}]}"',
    '}',
  ]);
  assert.deepEqual(byRule(denyOnly.findings, RULES.IAM_UNRESTRICTED), []);

  const document = tf([
    'data "aws_iam_policy_document" "admin" {',
    '  statement {',
    '    effect    = "Allow"',
    '    actions   = ["*"]',
    '    resources = ["*"]',
    '  }',
    '}',
  ]);
  const fromDocument = byRule(document.findings, RULES.IAM_UNRESTRICTED);
  assert.equal(fromDocument.length, 1);
  assert.equal(fromDocument[0].line, 2);
});

test('TF-11 missing logging is low for buckets and disabled CloudTrail', () => {
  const bucket = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
  ]);
  const flagged = byRule(bucket.findings, RULES.MISSING_LOGGING);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, 'low');

  const logged = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
    '',
    'resource "aws_s3_bucket_logging" "data" {',
    '  bucket        = aws_s3_bucket.data.id',
    '  target_bucket = "acme-logs"',
    '  target_prefix = "data/"',
    '}',
  ]);
  assert.deepEqual(byRule(logged.findings, RULES.MISSING_LOGGING), []);

  const trail = tf([
    'resource "aws_cloudtrail" "audit" {',
    '  name           = "audit"',
    '  s3_bucket_name = "acme-logs"',
    '  enable_logging = false',
    '}',
  ]);
  const trailFindings = byRule(trail.findings, RULES.MISSING_LOGGING);
  assert.equal(trailFindings.length, 1);
  assert.match(trailFindings[0].title, /enable_logging = false/);

  const activeTrail = tf([
    'resource "aws_cloudtrail" "audit" {',
    '  name           = "audit"',
    '  s3_bucket_name = "acme-logs"',
    '  enable_logging = true',
    '}',
  ]);
  assert.deepEqual(byRule(activeTrail.findings, RULES.MISSING_LOGGING), []);
});

test('TF-12 an unresolved value yields an explicit low coverage finding, never a confident pass', () => {
  const { findings } = tf([
    'resource "aws_db_instance" "main" {',
    '  identifier          = "main"',
    '  storage_encrypted   = var.encrypt_storage',
    '  publicly_accessible = "${var.public}"',
    '}',
    '',
    'resource "aws_security_group" "web" {',
    '  ingress {',
    '    from_port   = 443',
    '    to_port     = 443',
    '    cidr_blocks = var.allowed_cidrs',
    '  }',
    '}',
    '',
    'resource "aws_iam_policy" "p" {',
    '  name   = "p"',
    '  policy = jsonencode({ Statement = [] })',
    '}',
  ]);
  const coverage = byRule(findings, RULES.UNEVALUABLE);
  assert.equal(coverage.length, 4, 'one per undecidable attribute: ' + coverage.map((f) => f.title).join(' | '));
  for (const f of coverage) {
    assert.equal(f.severity, 'low');
    assert.equal(f.category, 'scan-coverage');
    assert.match(f.title, /could not be evaluated/);
  }
  const titles = coverage.map((f) => f.title).join(' | ');
  for (const attribute of ['storage_encrypted', 'publicly_accessible', 'cidr_blocks', 'policy']) {
    assert.match(titles, new RegExp(attribute + ' could not be evaluated'));
  }

  assert.deepEqual(byRule(findings, RULES.STORAGE_UNENCRYPTED), [], 'no confident encryption verdict');
  assert.deepEqual(byRule(findings, RULES.DATABASE_PUBLIC), [], 'no confident exposure verdict');
  assert.deepEqual(byRule(findings, RULES.SECURITY_GROUP_OPEN), [], 'no confident ingress verdict');
  assert.deepEqual(byRule(findings, RULES.IAM_UNRESTRICTED), [], 'no confident policy verdict');
});

test('TF-13 an unlinkable companion is reported as a caveat, not as silence', () => {
  const unlinkable = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
    '',
    'resource "aws_s3_bucket_server_side_encryption_configuration" "every" {',
    '  for_each = var.buckets',
    '  bucket   = each.value',
    '}',
  ]);
  const flagged = byRule(unlinkable.findings, RULES.S3_UNENCRYPTED);
  assert.equal(flagged.length, 1,
    'the bucket is still reported — an unresolvable companion may cover it, but silence would hide a real gap');
  assert.match(flagged[0].title, /could not resolve/,
    'the caveat must travel with the finding so the user can dismiss it');
  assert.ok(byRule(unlinkable.findings, RULES.UNEVALUABLE).some((f) => /bucket could not be evaluated/.test(f.title)));

  const linkedByName = tf([
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
    '',
    'resource "aws_s3_bucket_server_side_encryption_configuration" "data" {',
    '  bucket = each.value.id',
    '}',
  ]);
  assert.deepEqual(byRule(linkedByName.findings, RULES.S3_UNENCRYPTED), [],
    'a companion sharing the resource name still counts as covering the bucket');
  assert.deepEqual(byRule(linkedByName.findings, RULES.UNEVALUABLE), []);
});

test('TF-14 every rule id is unique, inside NPS-0670..0729 and carries a valid severity', () => {
  const seen = new Set();
  for (const rule of Object.values(RULES)) {
    assert.equal(idInRange(rule.id, 'misconfig'), true, rule.id + ' must be a misconfig id');
    const n = Number(rule.id.slice(4));
    assert.ok(n >= 670 && n <= 729, rule.id + ' must sit in the terraform sub-block');
    assert.equal(seen.has(rule.id), false, 'duplicate rule id ' + rule.id);
    seen.add(rule.id);
    assert.ok(SEVERITIES.includes(rule.severity), rule.id + ' severity');
    assert.ok(rule.rule_name && rule.category && rule.reminder, rule.id + ' metadata');
  }
  assert.equal(seen.size, Object.keys(RULES).length);
});

test('TF-15 findings carry the scanner and file, parser warnings surface, bad input warns', () => {
  const { findings, warnings } = check('resource "aws_s3_bucket" "b" {\n  bucket = "b"\n', { file: 'infra/main.tf' });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.equal(f.scanner, 'misconfig');
    assert.equal(f.source, 'builtin');
    assert.equal(f.file, 'infra/main.tf');
  }
  assert.ok(warnings.includes('unclosed-block'), 'parser warnings are surfaced: ' + warnings.join(','));

  assert.deepEqual(check('', { file: 'infra/main.tf' }), { findings: [], warnings: [] });
  for (const bad of [42, {}, [], true]) {
    assert.deepEqual(
      check(bad, { file: 'infra/main.tf' }),
      { findings: [], warnings: ['invalid-input'] },
      'non-string input must warn, never throw: ' + JSON.stringify(bad),
    );
  }
});

test('TF-16 a hardened configuration produces no findings at all', () => {
  const { findings } = tf([
    'terraform {',
    '  required_version = ">= 1.7.0"',
    '}',
    '',
    '# a private, encrypted, logged bucket',
    'resource "aws_s3_bucket" "data" {',
    '  bucket = "acme-data"',
    '}',
    '',
    'resource "aws_s3_bucket_public_access_block" "data" {',
    '  bucket                  = aws_s3_bucket.data.id',
    '  block_public_acls       = true',
    '  block_public_policy     = true',
    '  ignore_public_acls      = true',
    '  restrict_public_buckets = true',
    '}',
    '',
    'resource "aws_s3_bucket_acl" "data" {',
    '  bucket = aws_s3_bucket.data.id',
    '  acl    = "private"',
    '}',
    '',
    'resource "aws_s3_bucket_server_side_encryption_configuration" "data" {',
    '  bucket = aws_s3_bucket.data.id',
    '',
    '  rule {',
    '    apply_server_side_encryption_by_default {',
    '      sse_algorithm = "aws:kms"',
    '    }',
    '  }',
    '}',
    '',
    'resource "aws_s3_bucket_logging" "data" {',
    '  bucket        = aws_s3_bucket.data.id',
    '  target_bucket = "acme-logs"',
    '  target_prefix = "data/"',
    '}',
    '',
    'resource "aws_security_group" "web" {',
    '  name = "web"',
    '',
    '  ingress {',
    '    from_port   = 443',
    '    to_port     = 443',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["10.0.0.0/8"]',
    '  }',
    '}',
    '',
    'resource "aws_db_instance" "main" {',
    '  identifier          = "main"',
    '  storage_encrypted   = true',
    '  publicly_accessible = false',
    '}',
  ]);
  assert.deepEqual(findings, [], 'hardened config should be clean: ' + ids(findings));
});

test('TF-17 one unlinkable companion does not silence encryption checks for every bucket', () => {
  const buckets = 'resource "aws_s3_bucket" "public_data" {}\nresource "aws_s3_bucket" "logs" {}\n';
  const clean = check(buckets, { file: 'm.tf' }).findings.filter((f) => f.id === 'NPS-0672');
  assert.equal(clean.length, 2, 'baseline: both buckets flagged');

  const withUnlinkable = check(
    buckets + 'resource "aws_s3_bucket_server_side_encryption_configuration" "x" {\n  bucket = var.other\n}\n',
    { file: 'm.tf' },
  ).findings;
  assert.equal(
    withUnlinkable.filter((f) => f.id === 'NPS-0672').length, 2,
    'an unresolvable companion must not turn two real gaps into silence',
  );
  assert.equal(withUnlinkable.filter((f) => f.id === 'NPS-0679').length, 1, 'the coverage gap is still reported');
  assert.ok(
    withUnlinkable.some((f) => /could not resolve/.test(f.title || '')),
    'the finding must state the caveat so the user can dismiss the covered one',
  );
});

test('TF-18 the same holds for logging', () => {
  const buckets = 'resource "aws_s3_bucket" "a" {}\nresource "aws_s3_bucket" "b" {}\n';
  const withUnlinkable = check(
    buckets + 'resource "aws_s3_bucket_logging" "l" {\n  bucket = var.other\n}\n',
    { file: 'm.tf' },
  ).findings;
  assert.equal(withUnlinkable.filter((f) => f.id === 'NPS-0678').length, 2);
});

test('TF-19 a resolvable companion still suppresses only its own bucket', () => {
  const src = [
    'resource "aws_s3_bucket" "a" {}',
    'resource "aws_s3_bucket" "b" {}',
    'resource "aws_s3_bucket_server_side_encryption_configuration" "sse" {',
    '  bucket = aws_s3_bucket.a.id',
    '}',
  ].join('\n');
  const ids = check(src, { file: 'm.tf' }).findings.filter((f) => f.id === 'NPS-0672');
  assert.equal(ids.length, 1, 'only the uncovered bucket is flagged');
  assert.match(ids[0].title, /\bb\b/);
});

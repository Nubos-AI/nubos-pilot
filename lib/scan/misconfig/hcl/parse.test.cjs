'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseHcl } = require('./parse.cjs');
const { NubosPilotError } = require('../../../core.cjs');

function hcl(lines) {
  return parseHcl(lines.join('\n'));
}

function blockOf(result, type, label) {
  return result.blocks.find((b) => b.type === type && (label === undefined || b.labels[0] === label));
}

function warnedAbout(result, needle) {
  return result.warnings.some((w) => w.includes(needle));
}

test('HCL-1 block headers, labels and scalar attribute types', () => {
  const result = hcl([
    'terraform {',
    '  required_version = "1.7.5"',
    '}',
    '',
    'provider "aws" {',
    '  region = "eu-central-1"',
    '}',
    '',
    'resource "aws_db_instance" "primary" {',
    '  identifier          = "primary"',
    '  allocated_storage   = 20',
    '  multi_az            = true',
    '  publicly_accessible = false',
    '  backup_window       = null',
    '  ratio               = 1.5',
    '}',
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.blocks.length, 3);
  assert.deepEqual(blockOf(result, 'terraform').labels, []);
  assert.deepEqual(blockOf(result, 'provider').labels, ['aws']);
  const db = blockOf(result, 'resource', 'aws_db_instance');
  assert.deepEqual(db.labels, ['aws_db_instance', 'primary']);
  assert.equal(db.attributes.identifier, 'primary');
  assert.equal(db.attributes.allocated_storage, 20);
  assert.equal(db.attributes.multi_az, true);
  assert.equal(db.attributes.publicly_accessible, false);
  assert.equal(db.attributes.backup_window, null);
  assert.equal(db.attributes.ratio, 1.5);
});

test('HCL-2 nested blocks two deep keep their own attributes and line numbers', () => {
  const result = hcl([
    'resource "aws_security_group" "web" {',
    '  name = "web"',
    '',
    '  ingress {',
    '    from_port   = 443',
    '    to_port     = 443',
    '    cidr_blocks = ["10.0.0.0/8"]',
    '',
    '    nested {',
    '      deep = "yes"',
    '    }',
    '  }',
    '',
    '  egress {',
    '    from_port = 0',
    '  }',
    '}',
  ]);
  assert.deepEqual(result.warnings, []);
  const sg = result.blocks[0];
  assert.equal(sg.line, 1);
  assert.equal(sg.blocks.length, 2);
  const ingress = sg.blocks[0];
  assert.equal(ingress.type, 'ingress');
  assert.equal(ingress.line, 4);
  assert.deepEqual(ingress.attributes.cidr_blocks, ['10.0.0.0/8']);
  assert.equal(ingress.blocks.length, 1);
  assert.equal(ingress.blocks[0].type, 'nested');
  assert.equal(ingress.blocks[0].line, 9);
  assert.equal(ingress.blocks[0].attributes.deep, 'yes');
  assert.equal(sg.blocks[1].type, 'egress');
});

test('HCL-3 a heredoc containing braces does not break block nesting', () => {
  const result = hcl([
    'resource "aws_iam_role_policy" "p" {',
    '  name = "inline"',
    '  policy = <<EOF',
    '{',
    '  "Version": "2012-10-17",',
    '  "Statement": [',
    '    { "Effect": "Allow", "Action": "s3:GetObject" }',
    '  ]',
    '}',
    'EOF',
    '  role = "r"',
    '}',
    '',
    'resource "aws_s3_bucket" "after" {',
    '  bucket = "after"',
    '}',
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.blocks.length, 2, 'the heredoc braces must not open or close blocks');
  const policy = result.blocks[0];
  assert.equal(policy.blocks.length, 0);
  assert.equal(typeof policy.attributes.policy, 'string');
  assert.ok(policy.attributes.policy.includes('"Effect": "Allow"'));
  assert.ok(policy.attributes.policy.trim().startsWith('{'));
  assert.equal(policy.attributes.role, 'r');
  assert.equal(result.blocks[1].labels[1], 'after');
});

test('HCL-4 an indented heredoc is dedented and terminates on its delimiter', () => {
  const result = hcl([
    'resource "local_file" "f" {',
    '  content = <<-SCRIPT',
    '    #!/bin/sh',
    '    echo "not a comment: ${literal}"',
    '  SCRIPT',
    '  filename = "f.sh"',
    '}',
  ]);
  const file = result.blocks[0];
  assert.equal(file.attributes.filename, 'f.sh');
  assert.equal(typeof file.attributes.content, 'object');
  assert.equal(file.attributes.content.unresolved, true);
  assert.equal(file.attributes.content.construct, 'interpolation');

  const plain = hcl([
    'resource "local_file" "f" {',
    '  content = <<-SCRIPT',
    '      #!/bin/sh',
    '      echo hello',
    '  SCRIPT',
    '}',
  ]);
  assert.equal(plain.blocks[0].attributes.content, '#!/bin/sh\necho hello');
});

test('HCL-5 a dynamic block is warned about and skipped, not mis-parsed', () => {
  const result = hcl([
    'resource "aws_security_group" "web" {',
    '  name = "web"',
    '',
    '  dynamic "ingress" {',
    '    for_each = var.ports',
    '    content {',
    '      from_port   = ingress.value',
    '      to_port     = ingress.value',
    '      cidr_blocks = ["0.0.0.0/0"]',
    '    }',
    '  }',
    '',
    '  egress {',
    '    from_port = 0',
    '  }',
    '}',
  ]);
  assert.ok(warnedAbout(result, 'dynamic'), 'warnings must name the dynamic construct');
  const sg = result.blocks[0];
  assert.equal(sg.attributes.name, 'web');
  assert.deepEqual(sg.blocks.map((b) => b.type), ['egress'], 'the dynamic block is skipped entirely');
  assert.equal(sg.blocks[0].attributes.from_port, 0);
});

test('HCL-6 for_each and count are recorded as unresolved sentinels', () => {
  const result = hcl([
    'resource "aws_s3_bucket" "many" {',
    '  for_each = toset(var.names)',
    '  bucket   = each.key',
    '}',
    '',
    'resource "aws_instance" "web" {',
    '  count         = var.enabled ? 3 : 0',
    '  instance_type = "t3.micro"',
    '}',
  ]);
  assert.ok(warnedAbout(result, 'for_each'));
  assert.ok(warnedAbout(result, 'count'));
  const many = result.blocks[0];
  assert.equal(many.attributes.for_each.unresolved, true);
  assert.equal(many.attributes.for_each.construct, 'for_each');
  assert.equal(many.attributes.bucket.unresolved, true);
  const web = result.blocks[1];
  assert.equal(web.attributes.count.unresolved, true);
  assert.equal(web.attributes.count.construct, 'count');
  assert.equal(web.attributes.instance_type, 't3.micro', 'the attribute after count still parses');
});

test('HCL-7 an interpolated attribute is unresolved and distinguishable from an absent one', () => {
  const result = hcl([
    'resource "aws_db_instance" "interpolated" {',
    '  publicly_accessible = "${var.public}"',
    '}',
    '',
    'resource "aws_db_instance" "absent" {',
    '  identifier = "absent"',
    '}',
    '',
    'resource "aws_db_instance" "literal" {',
    '  publicly_accessible = true',
    '}',
  ]);
  const interpolated = result.blocks[0].attributes;
  const absent = result.blocks[1].attributes;
  const literal = result.blocks[2].attributes;

  assert.equal(Object.prototype.hasOwnProperty.call(interpolated, 'publicly_accessible'), true);
  assert.equal(interpolated.publicly_accessible.unresolved, true);
  assert.equal(interpolated.publicly_accessible.construct, 'interpolation');

  assert.equal(Object.prototype.hasOwnProperty.call(absent, 'publicly_accessible'), false);
  assert.equal(absent.publicly_accessible, undefined);

  assert.equal(literal.publicly_accessible, true);
  assert.ok(warnedAbout(result, 'interpolation'));
});

test('HCL-8 function calls, references and ternaries are named in warnings and left unresolved', () => {
  const result = hcl([
    'resource "aws_iam_policy" "p" {',
    '  policy      = jsonencode({ Version = "2012-10-17" })',
    '  bucket      = aws_s3_bucket.data.id',
    '  description = var.enabled ? "on" : "off"',
    '  tags        = merge(var.tags, { Name = "p" })',
    '  suffix      = "prod" == var.env',
    '}',
  ]);
  const attrs = result.blocks[0].attributes;
  assert.equal(attrs.policy.unresolved, true);
  assert.equal(attrs.policy.construct, 'function_call');
  assert.ok(warnedAbout(result, 'jsonencode'), 'the warning must name jsonencode');
  assert.ok(warnedAbout(result, 'merge'));
  assert.equal(attrs.bucket.unresolved, true);
  assert.equal(attrs.bucket.construct, 'reference');
  assert.equal(attrs.bucket.raw, 'aws_s3_bucket.data.id');
  assert.equal(attrs.description.unresolved, true);
  assert.equal(attrs.tags.unresolved, true);
  assert.equal(attrs.suffix.unresolved, true);
  assert.equal(attrs.suffix.construct, 'expression');
  assert.equal(result.blocks.length, 1);
});

test('HCL-9 lists, maps and for-expressions', () => {
  const result = hcl([
    'resource "aws_security_group" "web" {',
    '  cidr_blocks = ["0.0.0.0/0", "10.0.0.0/8"]',
    '  ports       = [22, 443]',
    '  tags = {',
    '    Name        = "web"',
    '    "cost:code" = "abc"',
    '    managed     = true',
    '  }',
    '  empty_list = []',
    '  empty_map  = {}',
    '  computed   = [for p in var.ports : tostring(p)]',
    '  mixed      = ["ok", var.other]',
    '}',
  ]);
  const attrs = result.blocks[0].attributes;
  assert.deepEqual(attrs.cidr_blocks, ['0.0.0.0/0', '10.0.0.0/8']);
  assert.deepEqual(attrs.ports, [22, 443]);
  assert.deepEqual(attrs.tags, { Name: 'web', 'cost:code': 'abc', managed: true });
  assert.deepEqual(attrs.empty_list, []);
  assert.deepEqual(attrs.empty_map, {});
  assert.equal(attrs.computed.unresolved, true);
  assert.equal(attrs.computed.construct, 'for_expression');
  assert.equal(attrs.mixed[0], 'ok');
  assert.equal(attrs.mixed[1].unresolved, true);
});

test('HCL-10 hash, double-slash and block comments are all ignored', () => {
  const result = hcl([
    '# a hash comment',
    '// a double slash comment',
    '/* a block',
    '   comment spanning lines with a { brace */',
    'resource "aws_s3_bucket" "b" { # trailing hash',
    '  bucket = "b" // trailing slashes',
    '  /* inline */ acl = "private"',
    '  tags = {',
    '    # inside a map',
    '    Name = "b"',
    '  }',
    '}',
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].attributes.bucket, 'b');
  assert.equal(result.blocks[0].attributes.acl, 'private');
  assert.deepEqual(result.blocks[0].attributes.tags, { Name: 'b' });
});

test('HCL-11 malformed input warns and returns what parsed instead of throwing', () => {
  const truncated = hcl([
    'resource "aws_s3_bucket" "good" {',
    '  bucket = "good"',
    '}',
    '',
    'resource "aws_s3_bucket" "broken" {',
    '  bucket =',
  ]);
  assert.equal(truncated.blocks.length, 2);
  assert.equal(truncated.blocks[0].attributes.bucket, 'good');
  assert.ok(truncated.warnings.length > 0);
  assert.ok(warnedAbout(truncated, 'unclosed-block') || warnedAbout(truncated, 'missing-value'));

  const garbage = hcl([
    '@@@ not hcl at all',
    'resource "aws_s3_bucket" "still" {',
    '  bucket = "still"',
    '}',
    '}',
    'resource {',
  ]);
  assert.ok(warnedAbout(garbage, 'unexpected-character'));
  assert.ok(garbage.blocks.some((b) => b.labels[1] === 'still'));

  const unterminated = parseHcl('resource "aws_s3_bucket" "b" {\n  bucket = "oops\n}\n');
  assert.ok(warnedAbout(unterminated, 'unterminated-string'));

  const openHeredoc = parseHcl('resource "x" "y" {\n  body = <<EOF\nnever closed\n');
  assert.ok(warnedAbout(openHeredoc, 'unterminated-heredoc'));

  for (const nasty of ['{{{{', '}}}}', 'a = = =', 'resource "x" {', '<<EOF', '/* open', '"', '=']) {
    assert.doesNotThrow(() => parseHcl(nasty), 'must not throw on: ' + nasty);
  }
});

test('HCL-12 empty input is empty and non-string input is rejected', () => {
  assert.deepEqual(parseHcl(''), { blocks: [], warnings: [] });
  assert.deepEqual(parseHcl(null), { blocks: [], warnings: [] });
  assert.deepEqual(parseHcl('\n\n# only a comment\n'), { blocks: [], warnings: [] });
  assert.throws(() => parseHcl({ blocks: [] }), (err) => {
    assert.ok(err instanceof NubosPilotError);
    assert.equal(err.code, 'scan-hcl-invalid-input');
    return true;
  });
});

test('HCL-13 deep nesting beyond the depth cap is skipped with a warning', () => {
  const result = parseHcl([
    'resource "a" "b" {',
    '  one {',
    '    two {',
    '      three = "x"',
    '    }',
    '  }',
    '}',
  ].join('\n'), { maxDepth: 2 });
  assert.ok(warnedAbout(result, 'nesting-too-deep'));
  assert.equal(result.blocks[0].blocks[0].type, 'one');
  assert.deepEqual(result.blocks[0].blocks[0].blocks, []);
});

test('HCL-14 escapes and escaped interpolation stay literal strings', () => {
  const result = hcl([
    'resource "aws_s3_bucket" "b" {',
    '  quoted  = "say \\"hi\\""',
    '  escaped = "$${not_interpolated}"',
    '  windows = "C:\\\\tmp"',
    '}',
  ]);
  const attrs = result.blocks[0].attributes;
  assert.equal(attrs.quoted, 'say "hi"');
  assert.equal(attrs.escaped, '${not_interpolated}');
  assert.equal(attrs.windows, 'C:\\tmp');
  assert.ok(!warnedAbout(result, 'interpolation'));
});

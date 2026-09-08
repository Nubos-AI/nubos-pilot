'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { SECRET_RULES, FIXTURE_EXCLUDE_PATHS, GENERIC_EXCLUDE_PATHS, ci } = require('./rules.cjs');
const { RULES_COUNT, scanContent, compileRules } = require('./scan.cjs');
const { _looksCatastrophic } = require('../../security/scan.cjs');
const { BUILTIN_PATTERNS } = require('../../security/patterns.cjs');
const finding = require('../finding.cjs');

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
const HEXDIGITS = DIGITS + 'abcdef';
const UPPER36 = UPPER + DIGITS;
const LOWER36 = LOWER + DIGITS;

function chars(n, seed, alphabet) {
  let out = '';
  let round = 0;
  while (out.length < n) {
    const digest = crypto.createHash('sha256').update(seed + ':' + round).digest();
    round++;
    for (const byte of digest) {
      out += alphabet[byte % alphabet.length];
      if (out.length >= n) break;
    }
  }
  return out;
}

const alnum = (n, seed) => chars(n, seed, ALNUM);
const hex = (n, seed) => chars(n, seed, HEXDIGITS);
const digits = (n, seed) => chars(n, seed, DIGITS);
const upper36 = (n, seed) => chars(n, seed, UPPER36);
const lower36 = (n, seed) => chars(n, seed, LOWER36);
const b64 = (n, seed) => chars(n, seed, ALNUM + '+/');
const b64url = (n, seed) => chars(n, seed, ALNUM + '-_');
const bcryptBody = (n, seed) => chars(n, seed, ALNUM + './');
const uuid = (seed) => [hex(8, seed + 'a'), hex(4, seed + 'b'), hex(4, seed + 'c'), hex(4, seed + 'd'), hex(12, seed + 'e')].join('-');

const DEFAULT_PATH = 'src/config.js';

const FIXTURES = {
  'NPS-0100': {
    content: 'AWS_SECRET_ACCESS_KEY = "' + b64(40, 'aws1') + '"',
    negatives: ['AWS_SECRET_ACCESS_KEY = "tooshort"', 'AWS_ACCESS_KEY_ID = "' + b64(40, 'aws1') + '"'],
  },
  'NPS-0101': {
    content: 'AWS_SESSION_TOKEN="' + b64(140, 'awst') + '"',
    negatives: ['AWS_SESSION_TOKEN="' + b64(40, 'awst') + '"'],
  },
  'NPS-0102': {
    path: 'deploy/sa.json',
    content: '  "private_key": "-----BEGIN PRIVATE KEY-----",',
    negatives: ['  "private_key_id": "' + hex(40, 'gpk') + '",'],
  },
  'NPS-0103': {
    path: 'deploy/sa.json',
    content: '  "type": "service_account",',
    negatives: ['  "type": "authorized_user",'],
  },
  'NPS-0104': {
    content: 'const key = "AIza' + b64url(35, 'gapi') + '";',
    negatives: ['const key = "AIza' + alnum(10, 'gapi') + '";'],
  },
  'NPS-0105': {
    content: 'clientSecret = "GOCSPX-' + b64url(28, 'goc') + '"',
    negatives: ['clientSecret = "GOCSPX-tooshort"'],
  },
  'NPS-0106': {
    content: 'refreshToken = "1//0' + b64url(48, 'grt') + '"',
    negatives: ['refreshToken = "1//0abc"'],
  },
  'NPS-0107': {
    content: 'AccountKey=' + b64(86, 'az1') + '==',
    negatives: ['AccountKey=' + b64(20, 'az1') + '=='],
  },
  'NPS-0108': {
    content: 'DefaultEndpointsProtocol=https;AccountName=mystorageacct;AccountKey=' + b64(86, 'az2') + '==',
    negatives: ['DefaultEndpointsProtocol=https;BlobEndpoint=https://acct.blob.core.windows.net'],
  },
  'NPS-0109': {
    content: 'AZURE_CLIENT_SECRET="aB18Q~' + b64url(32, 'aad') + '"',
    negatives: ['AZURE_CLIENT_SECRET="aB18Q~short"'],
  },
  'NPS-0110': {
    content: 'token = "ghp_' + alnum(36, 'ghp') + '"',
    negatives: ['token = "ghp_' + alnum(12, 'ghp') + '"'],
  },
  'NPS-0111': {
    content: 'token = "github_pat_' + alnum(22, 'gfg1') + '_' + alnum(59, 'gfg2') + '"',
    negatives: ['token = "github_pat_' + alnum(22, 'gfg1') + '_' + alnum(20, 'gfg2') + '"'],
  },
  'NPS-0112': {
    content: 'token = "gho_' + alnum(36, 'gho') + '"',
    negatives: ['token = "gho_' + alnum(20, 'gho') + '"'],
  },
  'NPS-0113': {
    content: 'token = "ghu_' + alnum(36, 'ghu') + '"',
    negatives: ['token = "ghx_' + alnum(36, 'ghu') + '"'],
  },
  'NPS-0114': {
    content: 'token = "ghr_' + alnum(36, 'ghr') + '"',
    negatives: ['token = "ghr_' + alnum(20, 'ghr') + '"'],
  },
  'NPS-0115': {
    content: 'CI_TOKEN="glpat-' + b64url(20, 'gl1') + '"',
    negatives: ['CI_TOKEN="glpat-tooshort"'],
  },
  'NPS-0116': {
    content: 'trigger = "glptt-' + hex(40, 'gl2') + '"',
    negatives: ['trigger = "glptt-' + hex(12, 'gl2') + '"'],
  },
  'NPS-0117': {
    content: 'runner = "GR1348941' + b64url(20, 'gl3') + '"',
    negatives: ['runner = "GR1348941short"'],
  },
  'NPS-0118': {
    content: 'SLACK_BOT_TOKEN="xoxb-' + digits(12, 'sb1') + '-' + digits(12, 'sb2') + '-' + alnum(24, 'sb3') + '"',
    negatives: ['SLACK_BOT_TOKEN="xoxb-123-456-abcdef"'],
  },
  'NPS-0119': {
    content: 'SLACK_USER_TOKEN="xoxp-' + digits(12, 'su1') + '-' + alnum(30, 'su2') + '"',
    negatives: ['SLACK_USER_TOKEN="xoxp-12-ab"'],
  },
  'NPS-0120': {
    content: 'SLACK_LEGACY="xoxa-2-' + alnum(30, 'sl1') + '"',
    negatives: ['SLACK_LEGACY="xoxa-2-abc"'],
  },
  'NPS-0121': {
    content: 'hook = "https://hooks.slack.com/services/T' + upper36(9, 'sw1') + '/B' + upper36(9, 'sw2') + '/' + alnum(24, 'sw3') + '"',
    negatives: ['hook = "https://hooks.slack.com/services/T123/B456/abc"'],
  },
  'NPS-0122': {
    content: 'key = "rk_live_' + alnum(24, 'rk') + '"',
    negatives: ['key = "rk_live_short"'],
  },
  'NPS-0123': {
    content: 'secretHeader = "whsec_' + alnum(32, 'wh') + '"',
    negatives: ['secretHeader = "whsec_short"'],
  },
  'NPS-0124': {
    content: 'key = "sk_test_' + alnum(24, 'skt') + '"',
    negatives: ['key = "sk_test_short"'],
  },
  'NPS-0125': {
    content: 'key = "pk_test_' + alnum(24, 'pkt') + '"',
    negatives: ['key = "pk_test_short"'],
  },
  'NPS-0126': {
    content: 'const apiSid = "SK' + hex(32, 'tw1') + '";',
    negatives: ['const apiSid = "SK' + hex(12, 'tw1') + '";'],
  },
  'NPS-0127': {
    content: 'const accountSid = "AC' + hex(32, 'tw2') + '";',
    negatives: ['const accountSid = "AC' + hex(12, 'tw2') + '";'],
  },
  'NPS-0128': {
    content: 'TWILIO_AUTH_TOKEN="' + hex(32, 'tw3') + '"',
    negatives: ['TWILIO_AUTH_TOKEN="short"'],
  },
  'NPS-0129': {
    content: 'mailer = "SG.' + b64url(22, 'sg1') + '.' + b64url(43, 'sg2') + '"',
    negatives: ['mailer = "SG.short.short"'],
  },
  'NPS-0130': {
    content: 'mailgun = "key-' + hex(32, 'mg') + '"',
    negatives: ['mailgun = "key-' + hex(12, 'mg') + '"'],
  },
  'NPS-0131': {
    content: 'mailchimp = "' + hex(32, 'mc') + '-us14"',
    negatives: ['mailchimp = "' + hex(32, 'mc') + '-eu14"'],
  },
  'NPS-0132': {
    content: 'openai = "sk-' + alnum(48, 'oa') + '"',
    negatives: ['openai = "sk-' + alnum(20, 'oa') + '"'],
  },
  'NPS-0133': {
    content: 'openai = "sk-proj-' + b64url(48, 'oap') + '"',
    negatives: ['openai = "sk-proj-short"'],
  },
  'NPS-0134': {
    content: 'anthropic = "sk-ant-api03-' + b64url(95, 'ant') + '"',
    negatives: ['anthropic = "sk-ant-api03-' + b64url(20, 'ant') + '"'],
  },
  'NPS-0135': {
    content: 'hub = "hf_' + alnum(37, 'hf') + '"',
    negatives: ['hub = "hf_' + alnum(12, 'hf') + '"'],
  },
  'NPS-0136': {
    content: 'registry = "npm_' + alnum(36, 'npm') + '"',
    negatives: ['registry = "npm_' + alnum(20, 'npm') + '"'],
  },
  'NPS-0137': {
    path: '.npmrc',
    content: '//registry.npmjs.org/:_authToken=' + b64url(36, 'nr'),
    negatives: [
      { path: '.npmrc', content: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' },
      { path: DEFAULT_PATH, content: '//registry.npmjs.org/:_authToken=' + b64url(36, 'nr') },
    ],
  },
  'NPS-0138': {
    content: 'twine = "pypi-AgEIcHlwaS5vcmc' + b64url(60, 'pypi') + '"',
    negatives: ['twine = "pypi-AgEIcHlwaS5vcmcshort"'],
  },
  'NPS-0139': {
    path: '.pypirc',
    content: 'password = ' + b64url(24, 'pc'),
    negatives: [
      { path: '.pypirc', content: 'password = ${PYPI_TOKEN}' },
      { path: DEFAULT_PATH, content: 'password = ' + b64url(24, 'pc') },
    ],
  },
  'NPS-0140': {
    content: 'gem = "rubygems_' + hex(48, 'rg') + '"',
    negatives: ['gem = "rubygems_' + hex(20, 'rg') + '"'],
  },
  'NPS-0141': {
    content: 'docker = "dckr_pat_' + b64url(28, 'dh') + '"',
    negatives: ['docker = "dckr_pat_short"'],
  },
  'NPS-0142': {
    content: 'CLOUDFLARE_API_TOKEN="' + b64url(40, 'cf') + '"',
    negatives: [
      'CLOUDFLARE_API_TOKEN="' + 'a'.repeat(40) + '"',
      'CLOUDFLARE_API_TOKEN="short"',
    ],
  },
  'NPS-0143': {
    content: 'CF_API_KEY="' + hex(37, 'cfg') + '"',
    negatives: ['CF_API_KEY="' + hex(12, 'cfg') + '"'],
  },
  'NPS-0144': {
    content: 'do = "dop_v1_' + hex(64, 'do1') + '"',
    negatives: ['do = "dop_v1_' + hex(20, 'do1') + '"'],
  },
  'NPS-0145': {
    content: 'do = "doo_v1_' + hex(64, 'do2') + '"',
    negatives: ['do = "dox_v1_' + hex(64, 'do2') + '"'],
  },
  'NPS-0146': {
    content: 'HEROKU_API_KEY="' + uuid('hk') + '"',
    negatives: ['HEROKU_API_KEY="not-a-uuid-value"'],
  },
  'NPS-0147': {
    content: 'DATADOG_API_KEY="' + hex(32, 'dd') + '"',
    negatives: ['DATADOG_API_KEY="' + '0'.repeat(32) + '"', 'DATADOG_API_KEY="short"'],
  },
  'NPS-0148': {
    content: 'newrelic = "NRAK-' + upper36(27, 'nr1') + '"',
    negatives: ['newrelic = "NRAK-SHORT"'],
  },
  'NPS-0149': {
    content: 'license = "' + hex(36, 'nr2') + 'NRAL"',
    negatives: ['license = "' + hex(12, 'nr2') + 'NRAL"'],
  },
  'NPS-0150': {
    content: 'sentry = "sntrys_' + b64url(48, 'sn') + '"',
    negatives: ['sentry = "sntrys_short"'],
  },
  'NPS-0151': {
    content: 'dsn = "https://' + hex(32, 'sd') + '@o123456.ingest.sentry.io/1234567"',
    negatives: ['dsn = "https://sentry.io/organizations/acme/issues/"'],
  },
  'NPS-0152': {
    content: 'ALGOLIA_ADMIN_KEY="' + hex(32, 'alg') + '"',
    negatives: ['ALGOLIA_ADMIN_KEY="' + '0'.repeat(32) + '"', 'ALGOLIA_ADMIN_KEY="short"'],
  },
  'NPS-0153': {
    content: 'fcm = "AAAA' + b64url(7, 'fc1') + ':APA91b' + b64url(120, 'fc2') + '"',
    negatives: ['fcm = "AAAA' + b64url(7, 'fc1') + ':APA91bshort"'],
  },
  'NPS-0154': {
    content: 'SUPABASE_SERVICE_ROLE_KEY="eyJ' + b64url(17, 'sr1') + '.eyJ' + b64url(27, 'sr2') + '.' + b64url(43, 'sr3') + '"',
    negatives: ['SUPABASE_ANON_KEY="eyJ' + b64url(17, 'sr1') + '.eyJ' + b64url(27, 'sr2') + '.' + b64url(43, 'sr3') + '"'],
  },
  'NPS-0155': {
    content: 'supabase = "sbp_' + hex(40, 'sb') + '"',
    negatives: ['supabase = "sbp_' + hex(12, 'sb') + '"'],
  },
  'NPS-0156': {
    content: 'supabase = "sb_secret_' + b64url(28, 'sbs') + '"',
    negatives: ['supabase = "sb_secret_short"'],
  },
  'NPS-0157': {
    content: 'url = "postgres://app:' + alnum(16, 'pg') + '@db.internal:5432/app"',
    negatives: [
      'url = "postgres://app@db.internal:5432/app"',
      'url = "postgres://app:${DB_PASS}@db.internal:5432/app"',
    ],
  },
  'NPS-0158': {
    content: 'url = "mysql://root:' + alnum(16, 'my') + '@127.0.0.1:3306/app"',
    negatives: ['url = "mysql://root@127.0.0.1:3306/app"'],
  },
  'NPS-0159': {
    content: 'url = "mongodb+srv://app:' + alnum(16, 'mo') + '@cluster0.example.net/app"',
    negatives: ['url = "mongodb+srv://app@cluster0.example.net/app"'],
  },
  'NPS-0160': {
    content: 'url = "rediss://:' + alnum(16, 'rd') + '@cache.internal:6380"',
    negatives: ['url = "redis://cache.internal:6379"'],
  },
  'NPS-0161': {
    content: 'url = "amqps://svc:' + alnum(16, 'aq') + '@broker.internal:5671/vhost"',
    negatives: ['url = "amqps://broker.internal:5671/vhost"'],
  },
  'NPS-0162': {
    content: 'const t = "eyJ' + b64url(17, 'j1') + '.eyJ' + b64url(27, 'j2') + '.' + b64url(43, 'j3') + '";',
    negatives: ['const t = "eyJ' + b64url(17, 'j1') + '..' + b64url(43, 'j3') + '";'],
  },
  'NPS-0163': {
    content: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    negatives: ['-----BEGIN PGP PUBLIC KEY BLOCK-----'],
  },
  'NPS-0164': {
    content: '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    negatives: ['-----BEGIN PUBLIC KEY-----'],
  },
  'NPS-0165': {
    path: 'keys/deploy.ppk',
    content: 'PuTTY-User-Key-File-3: ssh-ed25519',
    negatives: [{ path: 'keys/deploy.ppk', content: 'PuTTY-User-Key-File-3: unknown-type' }],
  },
  'NPS-0166': {
    content: 'const k = "b3BlbnNzaC1rZXktdjEAAAAA' + b64(40, 'os') + '";',
    negatives: ['const k = "' + b64(40, 'os') + '";'],
  },
  'NPS-0167': {
    path: 'k8s/secret.yaml',
    content: 'type: kubernetes.io/service-account-token',
    negatives: [{ path: 'k8s/secret.yaml', content: 'type: Opaque' }],
  },
  'NPS-0168': {
    content: 'token = "' + alnum(14, 'tf1') + '.atlasv1.' + b64url(60, 'tf2') + '"',
    negatives: ['token = "' + alnum(14, 'tf1') + '.atlasv1.short"'],
  },
  'NPS-0169': {
    content: 'VAULT_TOKEN="hvs.' + b64url(28, 'vt') + '"',
    negatives: ['VAULT_TOKEN="hvs.short"'],
  },
  'NPS-0170': {
    content: 'VAULT_TOKEN="hvb.' + b64url(28, 'vb') + '"',
    negatives: ['VAULT_TOKEN="hvb.short"'],
  },
  'NPS-0171': {
    content: 'VAULT_TOKEN="s.' + alnum(24, 'vl') + '"',
    negatives: ['VAULT_TOKEN="s.' + alnum(10, 'vl') + '"'],
  },
  'NPS-0172': {
    content: 'shopify = "shpat_' + hex(32, 'sp1') + '"',
    negatives: ['shopify = "shpat_' + hex(12, 'sp1') + '"'],
  },
  'NPS-0173': {
    content: 'shopify = "shpss_' + hex(32, 'sp2') + '"',
    negatives: ['shopify = "shpss_' + hex(12, 'sp2') + '"'],
  },
  'NPS-0174': {
    content: 'shopify = "shpca_' + hex(32, 'sp3') + '"',
    negatives: ['shopify = "shpxx_' + hex(32, 'sp3') + '"'],
  },
  'NPS-0175': {
    content: 'square = "sq0atp-' + b64url(22, 'sq1') + '"',
    negatives: ['square = "sq0atp-short"'],
  },
  'NPS-0176': {
    content: 'square = "sq0csp-' + b64url(43, 'sq2') + '"',
    negatives: ['square = "sq0csp-short"'],
  },
  'NPS-0177': {
    content: 'bt = "access_token$production$' + lower36(16, 'bt1') + '$' + hex(32, 'bt2') + '"',
    negatives: ['bt = "access_token$production$short$' + hex(32, 'bt2') + '"'],
  },
  'NPS-0178': {
    content: 'bt = "access_token$sandbox$' + lower36(16, 'bt3') + '$' + hex(32, 'bt4') + '"',
    negatives: ['bt = "access_token$production$' + lower36(16, 'bt3') + '$' + hex(32, 'bt4') + '"'],
  },
  'NPS-0179': {
    content: 'PAYPAL_CLIENT_SECRET="' + b64url(48, 'pp') + '"',
    negatives: ['PAYPAL_CLIENT_SECRET="' + 'a'.repeat(48) + '"', 'PAYPAL_CLIENT_SECRET="short"'],
  },
  'NPS-0180': {
    content: 'jira = "ATATT3xFfGF0' + b64url(180, 'at') + '="',
    negatives: ['jira = "ATATT3xFfGF0' + b64url(20, 'at') + '="'],
  },
  'NPS-0181': {
    content: 'netlify = "nfp_' + b64url(36, 'nl') + '"',
    negatives: ['netlify = "nfp_short"'],
  },
  'NPS-0182': {
    content: 'VERCEL_TOKEN="' + alnum(24, 'vc') + '"',
    negatives: ['VERCEL_TOKEN="' + 'a'.repeat(24) + '"', 'VERCEL_TOKEN="short"'],
  },
  'NPS-0183': {
    content: 'linear = "lin_api_' + alnum(40, 'ln') + '"',
    negatives: ['linear = "lin_api_short"'],
  },
  'NPS-0184': {
    content: 'notion = "secret_' + alnum(43, 'nt') + '"',
    negatives: ['notion = "secret_' + alnum(12, 'nt') + '"'],
  },
  'NPS-0185': {
    content: 'discord = "M' + b64url(24, 'dc1') + '.' + b64url(6, 'dc2') + '.' + b64url(30, 'dc3') + '"',
    negatives: ['discord = "M' + b64url(5, 'dc1') + '.' + b64url(6, 'dc2') + '.' + b64url(30, 'dc3') + '"'],
  },
  'NPS-0186': {
    content: 'hook = "https://discord.com/api/webhooks/' + digits(18, 'dw1') + '/' + b64url(68, 'dw2') + '"',
    negatives: ['hook = "https://discord.com/api/webhooks/123/abc"'],
  },
  'NPS-0187': {
    content: 'telegram = "123456789:AA' + b64url(33, 'tg') + '"',
    negatives: ['telegram = "123456789:AA' + b64url(10, 'tg') + '"'],
  },
  'NPS-0188': {
    content: 'bearerToken = "' + 'A'.repeat(21) + alnum(40, 'twb') + '"',
    negatives: ['bearerToken = "' + 'A'.repeat(21) + alnum(10, 'twb') + '"'],
  },
  'NPS-0189': {
    content: 'endpoint = "https://admin:' + alnum(16, 'ba') + '@internal.example.com/api"',
    negatives: ['endpoint = "https://admin@internal.example.com/api"'],
  },
  'NPS-0190': {
    content: 'headers["Authorization"] = "Bearer ' + b64url(48, 'br') + '";',
    negatives: [
      'headers["Authorization"] = "Bearer ' + 'a'.repeat(48) + '";',
      'headers["Authorization"] = "Bearer short";',
    ],
  },
  'NPS-0191': {
    content: 'Authorization: Basic ' + b64(24, 'bh') + '==',
    negatives: ['Authorization: Bearer abc'],
  },
  'NPS-0192': {
    path: '.env',
    content: 'DATABASE_PASSWORD=' + alnum(16, 'ev'),
    negatives: [
      { path: '.env', content: 'DATABASE_PASSWORD=${DB_PASSWORD}' },
      { path: '.env.example', content: 'DATABASE_PASSWORD=' + alnum(16, 'ev') },
      { path: DEFAULT_PATH, content: 'DATABASE_PASSWORD=' + alnum(16, 'ev') },
    ],
  },
  'NPS-0193': {
    content: 'hash = "$2b$12$' + bcryptBody(53, 'bc') + '"',
    negatives: ['hash = "$2b$12$short"'],
  },
  'NPS-0194': {
    content: 'const apiKey = "' + alnum(40, 'he') + '";',
    negatives: [
      'const apiKey = "' + 'a'.repeat(40) + '";',
      'const label = "' + alnum(40, 'he') + '";',
    ],
  },
};

const SANDBOX_RULE_RE = /(?:_test_|sandbox)/;
const LIVE_SHAPE_RE = /(?:_live_|ghp_|glpat|xoxb|dop_v1|AKIA)/;
const ALLOWED_CWE = new Set(['CWE-798', 'CWE-522']);

test('SEC-1 the rule table is non-empty, frozen and matches the exported count', () => {
  assert.ok(SECRET_RULES.length >= 70, 'expected ~70 provider rules, got ' + SECRET_RULES.length);
  assert.equal(RULES_COUNT, SECRET_RULES.length);
  assert.ok(Object.isFrozen(SECRET_RULES));
  for (const rule of SECRET_RULES) {
    assert.ok(Object.isFrozen(rule), rule.id + ' must be frozen');
    assert.ok(Object.isFrozen(rule.cwe), rule.id + ' cwe list must be frozen');
  }
});

test('SEC-2 every rule id is valid, unique and inside the secrets range', () => {
  const seen = new Set();
  for (const rule of SECRET_RULES) {
    assert.ok(finding.isValidRuleId(rule.id), rule.rule_name + ' needs an NPS id');
    assert.ok(finding.idInRange(rule.id, 'secrets'), rule.id + ' is outside NPS-0100..NPS-0299');
    assert.ok(!seen.has(rule.id), 'duplicate id ' + rule.id);
    seen.add(rule.id);
  }
});

test('SEC-3 no secret rule id collides with the patterns scanner ids', () => {
  const patternIds = new Set(BUILTIN_PATTERNS.map((r) => r.id));
  for (const rule of SECRET_RULES) {
    assert.ok(!patternIds.has(rule.id), rule.id + ' collides with a patterns.cjs rule');
    assert.ok(!finding.idInRange(rule.id, 'patterns'), rule.id + ' sits in the patterns range');
  }
});

test('SEC-4 no shipped rule regex is ReDoS-prone', () => {
  for (const rule of SECRET_RULES) {
    if (typeof rule.regex !== 'string') continue;
    assert.equal(
      _looksCatastrophic(rule.regex),
      false,
      rule.id + ' ' + rule.rule_name + ' has a catastrophic regex: ' + rule.regex,
    );
  }
});

test('SEC-5 every rule carries a matcher, category, severity, CWE and reminder', () => {
  for (const rule of SECRET_RULES) {
    const hasMatcher = (typeof rule.regex === 'string' && rule.regex !== '')
      || (Array.isArray(rule.substrings) && rule.substrings.length > 0);
    assert.ok(hasMatcher, rule.id + ' needs a regex or substrings matcher');
    assert.ok(typeof rule.category === 'string' && rule.category !== '', rule.id + ' needs a category');
    assert.ok(finding.SEVERITY_RANK[rule.severity] !== undefined, rule.id + ' severity: ' + rule.severity);
    assert.ok(Array.isArray(rule.cwe) && rule.cwe.length > 0, rule.id + ' needs a CWE');
    for (const cwe of rule.cwe) {
      assert.ok(ALLOWED_CWE.has(cwe), rule.id + ' uses an ill-fitting CWE: ' + cwe);
    }
    assert.ok(typeof rule.reminder === 'string' && rule.reminder.length > 20, rule.id + ' needs a reminder');
  }
});

test('SEC-6 test and sandbox key shapes stay low severity', () => {
  const sandbox = SECRET_RULES.filter((r) => SANDBOX_RULE_RE.test(r.rule_name));
  assert.ok(sandbox.length >= 3, 'expected test/sandbox rules to exist');
  for (const rule of sandbox) {
    assert.equal(rule.severity, 'low', rule.id + ' ' + rule.rule_name + ' must not shout about a test key');
  }
});

test('SEC-7 provably live credential shapes are high or critical', () => {
  const live = SECRET_RULES.filter(
    (r) => typeof r.regex === 'string' && LIVE_SHAPE_RE.test(r.regex) && !SANDBOX_RULE_RE.test(r.rule_name),
  );
  assert.ok(live.length >= 3, 'expected live-shape rules to exist');
  for (const rule of live) {
    assert.ok(
      finding.atLeast(rule.severity, 'high'),
      rule.id + ' ' + rule.rule_name + ' matches a live credential shape but is ' + rule.severity,
    );
  }
});

test('SEC-8 generic and heuristic rules never exceed medium severity', () => {
  const generic = SECRET_RULES.filter((r) => r.category === 'generic-credential');
  assert.ok(generic.length >= 4, 'expected generic rules to exist');
  for (const rule of generic) {
    assert.ok(
      !finding.atLeast(rule.severity, 'high'),
      rule.id + ' ' + rule.rule_name + ' is generic but graded ' + rule.severity,
    );
  }
});

test('SEC-9 every rule has a positive fixture and at least one near miss', () => {
  const ids = SECRET_RULES.map((r) => r.id);
  for (const id of ids) {
    const fixture = FIXTURES[id];
    assert.ok(fixture, id + ' has no fixture');
    assert.ok(typeof fixture.content === 'string' && fixture.content !== '', id + ' needs positive content');
    assert.ok(Array.isArray(fixture.negatives) && fixture.negatives.length > 0, id + ' needs a near miss');
  }
  for (const id of Object.keys(FIXTURES)) {
    assert.ok(ids.includes(id), 'fixture ' + id + ' has no matching rule');
  }
});

test('SEC-10 every positive fixture fires exactly its own rule', () => {
  for (const rule of SECRET_RULES) {
    const fixture = FIXTURES[rule.id];
    const filePath = fixture.path || DEFAULT_PATH;
    const { findings } = scanContent({ filePath, content: fixture.content, rules: [rule] });
    assert.equal(
      findings.length,
      1,
      rule.id + ' ' + rule.rule_name + ' did not fire on its positive fixture: ' + fixture.content.slice(0, 60),
    );
    assert.equal(findings[0].id, rule.id);
    assert.equal(findings[0].scanner, 'secrets');
    assert.equal(findings[0].severity, rule.severity);
  }
});

test('SEC-11 every near miss stays silent for its own rule', () => {
  for (const rule of SECRET_RULES) {
    const fixture = FIXTURES[rule.id];
    for (const negative of fixture.negatives) {
      const entry = typeof negative === 'string' ? { path: fixture.path || DEFAULT_PATH, content: negative } : negative;
      const { findings } = scanContent({ filePath: entry.path, content: entry.content, rules: [rule] });
      assert.equal(
        findings.length,
        0,
        rule.id + ' ' + rule.rule_name + ' fired on a near miss: ' + entry.content.slice(0, 60),
      );
    }
  }
});

test('SEC-12 the whole table compiles and entropy rules expose one capture group', () => {
  const compiled = compileRules(SECRET_RULES);
  assert.equal(compiled.length, SECRET_RULES.length);
  const entropyRules = SECRET_RULES.filter((r) => r.entropy);
  assert.ok(entropyRules.length >= 4, 'expected entropy-gated rules to exist');
  for (const rule of entropyRules) {
    assert.equal(new RegExp(rule.regex + '|').exec('').length - 1, 1, rule.id + ' needs one capture group');
  }
});

test('SEC-13 exclusion sets keep fixture homes out but leave prose to the live rules', () => {
  assert.ok(FIXTURE_EXCLUDE_PATHS.includes('**/*.example'));
  assert.ok(FIXTURE_EXCLUDE_PATHS.includes('**/fixtures/**'));
  assert.ok(!FIXTURE_EXCLUDE_PATHS.includes('**/*.md'));
  assert.ok(GENERIC_EXCLUDE_PATHS.includes('**/*.md'));
  assert.ok(GENERIC_EXCLUDE_PATHS.includes('**/*.test.*'));
  for (const rule of SECRET_RULES) {
    if (rule.category !== 'generic-credential') continue;
    assert.equal(rule.exclude_paths, GENERIC_EXCLUDE_PATHS, rule.id + ' generic rule must use the generic exclusions');
  }
});

test('SEC-14 ci() builds a case-insensitive source and rejects unsafe keywords', () => {
  assert.equal(ci('aws'), '[aA][wW][sS]');
  assert.equal(ci('api_key'), '[aA][pP][iI]_[kK][eE][yY]');
  assert.throws(() => ci('api.key'), (err) => err.code === 'secrets-keyword-unsafe');
  assert.throws(() => ci(''), (err) => err.code === 'secrets-keyword-unsafe');
});

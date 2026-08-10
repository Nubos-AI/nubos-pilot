'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render } = require('./generate-attributions.cjs');
const compact = require('./advisory-compact.cjs');
const builder = require('./build-advisory-db.cjs');

const DATA_DIR = path.join(__dirname, '..', 'lib', 'scan', 'data');

function withSnapshot(fn) {
  const existed = fs.existsSync(DATA_DIR);
  if (existed) throw new Error('lib/scan/data already exists — refusing to clobber a real snapshot');
  const built = compact.buildShards([{
    id: 'GHSA-attr-test',
    summary: 'test',
    affected: [{ package: { ecosystem: 'npm', name: 'yaml' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.0.0' }] }] }],
  }]);
  builder.writeShards(DATA_DIR, built, {
    generatedAt: '2026-08-03T00:00:00.000Z',
    toolVersion: '1.5.0',
    feeds: builder.FEEDS,
  });
  try { return fn(); }
  finally { fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
}

test('ATTR-1 the bundled-data section is always present', () => {
  assert.match(render(), /^## Bundled data$/m);
});

test('ATTR-2 without a snapshot it says so rather than staying silent', () => {
  if (fs.existsSync(DATA_DIR)) return;
  const body = render();
  assert.match(body, /No advisory snapshot is bundled/);
  assert.ok(!/\| Data source \| License \|/.test(body));
});

test('ATTR-3 with a snapshot every source and license is named', () => {
  withSnapshot(() => {
    const body = render();
    assert.match(body, /\| Data source \| License \|/);
    for (const feed of builder.FEEDS) {
      assert.ok(body.includes('| ' + feed.eco + ' |'), 'source not attributed: ' + feed.eco);
    }
  });
});

test('ATTR-4 the license of every shipped feed appears verbatim', () => {
  withSnapshot(() => {
    const body = render();
    for (const license of new Set(builder.FEEDS.map((f) => f.license))) {
      assert.ok(body.includes(license), 'license not attributed: ' + license);
    }
  });
});

test('ATTR-5 attribution is stated as a condition, not a courtesy', () => {
  withSnapshot(() => {
    assert.match(render(), /condition of redistribution/);
  });
});

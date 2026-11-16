'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const db = require('./db.cjs');
const { lookup, lookupMany, _binarySearch } = require('./malicious.cjs');

const NPM_LINES = [
  'async-payload\tMAL-0003\t1.0.0,1.0.1',
  'evil-pkg\tMAL-0001\t*',
  'left-pad-evil\tMAL-0002\t9.9.9',
  'zzz-last\tMAL-0009\t*',
];

function withShard(ecosystem, text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-advisory-mal-'));
  const file = 'malicious-' + ecosystem + '.txt.gz';
  const bytes = zlib.gzipSync(Buffer.from(text, 'utf-8'));
  fs.writeFileSync(path.join(dir, file), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema_version: db.SCHEMA_VERSION,
    generated_at: '2026-07-01T00:00:00.000Z',
    tool_version: '1.5.0',
    ecosystems: { [ecosystem]: { advisories: 0, malicious: 1 } },
    sources: [{ name: 'OSV', license: 'CC-BY-4.0' }],
    sha256: { [file]: crypto.createHash('sha256').update(bytes).digest('hex') },
  }));
  db._clearCache();
  try {
    return fn(db.loadMaliciousShard(dir, ecosystem));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function generated(count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const n = String(i).padStart(5, '0');
    lines.push('pkg-' + n + '\tMAL-' + n + '\t*');
  }
  return lines.sort().join('\n') + '\n';
}

test('MAL-1 lookup finds a record and reports its id and versions', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'evil-pkg'), { id: 'MAL-0001', versions: ['*'] });
    assert.deepEqual(lookup(shard, 'npm', 'async-payload'), { id: 'MAL-0003', versions: ['1.0.0', '1.0.1'] });
    assert.deepEqual(lookup(shard, 'npm', 'left-pad-evil'), { id: 'MAL-0002', versions: ['9.9.9'] });
  });
});

test('MAL-2 lookup misses before, between and after the sorted range', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    assert.equal(lookup(shard, 'npm', 'aaa-first'), null);
    assert.equal(lookup(shard, 'npm', 'lodash'), null);
    assert.equal(lookup(shard, 'npm', 'zzzz-after'), null);
    assert.equal(lookup(shard, 'npm', ''), null);
    assert.equal(lookup(shard, 'npm', null), null);
  });
});

test('MAL-3 boundary records at both ends of the shard are reachable', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    assert.equal(_binarySearch(shard, 'async-payload').id, 'MAL-0003');
    assert.equal(_binarySearch(shard, 'zzz-last').id, 'MAL-0009');
    assert.equal(_binarySearch(shard, 'zzz-lasu'), null);
  });
});

test('MAL-4 a * record condemns every installed version', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    const hits = lookupMany(shard, 'npm', [
      { ecosystem: 'npm', name: 'evil-pkg', version: '0.0.1' },
      { ecosystem: 'npm', name: 'evil-pkg', version: '17.4.2' },
      { ecosystem: 'npm', name: 'evil-pkg', version: null },
    ]);
    assert.equal(hits.length, 3);
    for (const hit of hits) {
      assert.equal(hit.id, 'MAL-0001');
      assert.deepEqual(hit.versions, ['*']);
    }
  });
});

test('MAL-5 a version-scoped record only matches the installed version', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    const hits = lookupMany(shard, 'npm', [
      { ecosystem: 'npm', name: 'async-payload', version: '1.0.1' },
      { ecosystem: 'npm', name: 'async-payload', version: '2.0.0' },
      { ecosystem: 'npm', name: 'async-payload', version: null },
      { ecosystem: 'npm', name: 'left-pad-evil', version: '9.9.9' },
      { ecosystem: 'npm', name: 'left-pad-evil', version: '9.9.8' },
    ]);
    assert.deepEqual(hits.map((h) => h.package.version + ' ' + h.id), ['1.0.1 MAL-0003', '9.9.9 MAL-0002']);
  });
});

test('MAL-6 lookupMany skips packages from another ecosystem and accepts bare names', () => {
  withShard('npm', NPM_LINES.join('\n') + '\n', (shard) => {
    const hits = lookupMany(shard, 'npm', [
      { ecosystem: 'PyPI', name: 'evil-pkg', version: '1.0.0' },
      { ecosystem: 'npm', name: 'lodash', version: '4.17.21' },
      'evil-pkg',
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].package, 'evil-pkg');
    assert.equal(hits[0].id, 'MAL-0001');
    assert.deepEqual(lookupMany(shard, 'npm', null), []);
    assert.deepEqual(lookupMany(null, 'npm', ['evil-pkg']), []);
  });
});

test('MAL-7 the lookup key is the normalized name, so Flask_SQLAlchemy finds flask-sqlalchemy', () => {
  const lines = ['django-evil\tMAL-1001\t*', 'flask-sqlalchemy\tMAL-1002\t2.5.0'];
  withShard('PyPI', lines.join('\n') + '\n', (shard) => {
    assert.deepEqual(lookup(shard, 'PyPI', 'Flask_SQLAlchemy'), { id: 'MAL-1002', versions: ['2.5.0'] });
    assert.deepEqual(lookup(shard, 'PyPI', 'Flask.SQLAlchemy'), { id: 'MAL-1002', versions: ['2.5.0'] });
    assert.deepEqual(lookup(shard, 'PyPI', '  flask-sqlalchemy  '), { id: 'MAL-1002', versions: ['2.5.0'] });
    const hits = lookupMany(shard, 'PyPI', [{ ecosystem: 'PyPI', name: 'Flask_SQLAlchemy', version: '2.5.0' }]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'MAL-1002');
  });
  withShard('npm', ['evil-pkg\tMAL-0001\t*'].join('\n'), (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'EVIL-PKG'), { id: 'MAL-0001', versions: ['*'] });
  });
});

test('MAL-8 the lookup cost stays logarithmic as the shard grows a thousandfold', () => {
  const small = generated(10);
  const big = generated(10000);
  withShard('npm', small, (smallShard) => {
    withShard('npm', big, (bigShard) => {
      const smallStats = { probes: 0 };
      const bigStats = { probes: 0 };
      assert.equal(lookup(smallShard, 'npm', 'pkg-00009', smallStats).id, 'MAL-00009');
      assert.equal(lookup(bigShard, 'npm', 'pkg-09999', bigStats).id, 'MAL-09999');

      const linearProbes = 10000;
      assert.ok(bigStats.probes * 100 < linearProbes, 'probes ' + bigStats.probes + ' must be far below a full scan');
      assert.ok(
        bigStats.probes <= Math.ceil(Math.log2(bigShard.bytes)) + 2,
        'probes ' + bigStats.probes + ' must stay within the bisection bound for ' + bigShard.bytes + ' bytes',
      );
      assert.ok(
        bigStats.probes <= smallStats.probes + Math.ceil(Math.log2(1000)) + 4,
        'a 1000x larger shard must cost additively more probes, not 1000x: '
          + bigStats.probes + ' against ' + smallStats.probes,
      );

      for (const index of [0, 1, 4999, 9998, 9999]) {
        const key = 'pkg-' + String(index).padStart(5, '0');
        const stats = { probes: 0 };
        assert.equal(lookup(bigShard, 'npm', key, stats).id, 'MAL-' + String(index).padStart(5, '0'));
        assert.ok(stats.probes <= Math.ceil(Math.log2(bigShard.bytes)) + 2, key + ' took ' + stats.probes + ' probes');
      }
      const missStats = { probes: 0 };
      assert.equal(lookup(bigShard, 'npm', 'pkg-10000', missStats), null);
      assert.ok(missStats.probes <= Math.ceil(Math.log2(bigShard.bytes)) + 2);
    });
  });
});

test('MAL-9 every record in a large shard is findable by binary search', () => {
  withShard('npm', generated(2000), (shard) => {
    for (let i = 0; i < 2000; i += 1) {
      const n = String(i).padStart(5, '0');
      const record = _binarySearch(shard, 'pkg-' + n);
      assert.equal(record && record.id, 'MAL-' + n, 'pkg-' + n + ' must be found');
    }
  });
});

test('MAL-10 CRLF line endings do not leak into the key, the id or the versions', () => {
  const text = NPM_LINES.join('\r\n') + '\r\n';
  withShard('npm', text, (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'evil-pkg'), { id: 'MAL-0001', versions: ['*'] });
    assert.deepEqual(lookup(shard, 'npm', 'zzz-last'), { id: 'MAL-0009', versions: ['*'] });
    assert.deepEqual(lookup(shard, 'npm', 'async-payload'), { id: 'MAL-0003', versions: ['1.0.0', '1.0.1'] });
    assert.equal(lookup(shard, 'npm', 'lodash'), null);
  });
});

test('MAL-11 a shard with no trailing newline behaves like one with it', () => {
  withShard('npm', NPM_LINES.join('\n'), (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'zzz-last'), { id: 'MAL-0009', versions: ['*'] });
    assert.deepEqual(lookup(shard, 'npm', 'async-payload').versions, ['1.0.0', '1.0.1']);
  });
  withShard('npm', NPM_LINES.join('\n') + '\n\n', (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'zzz-last'), { id: 'MAL-0009', versions: ['*'] });
  });
});

test('MAL-12 an empty shard is a miss, not a crash', () => {
  withShard('npm', '', (shard) => {
    assert.equal(shard.bytes, 0);
    assert.equal(lookup(shard, 'npm', 'evil-pkg'), null);
    assert.deepEqual(lookupMany(shard, 'npm', [{ ecosystem: 'npm', name: 'evil-pkg', version: '1.0.0' }]), []);
  });
  withShard('npm', '\n', (shard) => {
    assert.equal(lookup(shard, 'npm', 'evil-pkg'), null);
  });
  assert.equal(_binarySearch(null, 'evil-pkg'), null);
  assert.equal(_binarySearch({ buffer: 'not a buffer' }, 'evil-pkg'), null);
});

test('MAL-13 lookup agrees with the sort order the builder renders', () => {
  const compact = require('../../../scripts/advisory-compact.cjs');
  const names = ['Flask_SQLAlchemy', 'requests-toolbelt-evil', 'ZZTop', 'aaa-first', 'Numpy_Evil'];
  const built = compact.buildShards(names.map((name, index) => ({
    id: 'MAL-2024-' + String(index).padStart(4, '0'),
    summary: 'malicious code',
    affected: [{
      package: { ecosystem: 'PyPI', name },
      versions: index === 0 ? ['9.9.9'] : [],
    }],
  })));
  const text = compact.renderMaliciousShard(built.malicious.get('PyPI'));
  withShard('PyPI', text, (shard) => {
    names.forEach((name, index) => {
      const hit = lookup(shard, 'PyPI', name);
      assert.equal(hit && hit.id, 'MAL-2024-' + String(index).padStart(4, '0'), name + ' must be found');
    });
    assert.deepEqual(lookup(shard, 'PyPI', 'flask-sqlalchemy').versions, ['9.9.9']);
    assert.deepEqual(lookup(shard, 'PyPI', 'zztop').versions, ['*']);
    assert.equal(lookup(shard, 'PyPI', 'numpy'), null);
  });
});

test('MAL-14 a record with only a name and an id is treated as every version', () => {
  withShard('npm', 'lonely-pkg\tMAL-7777\n', (shard) => {
    assert.deepEqual(lookup(shard, 'npm', 'lonely-pkg'), { id: 'MAL-7777', versions: ['*'] });
    const hits = lookupMany(shard, 'npm', [{ ecosystem: 'npm', name: 'lonely-pkg', version: '3.1.4' }]);
    assert.equal(hits.length, 1);
  });
});

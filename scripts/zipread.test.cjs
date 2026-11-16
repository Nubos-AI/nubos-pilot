'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');

const { readEntries, eachEntry, inflateEntry, _crc32 } = require('./zipread.cjs');

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UTF8_NAME_FLAG = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_NEEDED_ZIP64 = 45;

const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_EOCD_REMAINING_SIZE = 44n;
const ZIP64_EXTRA_HEADER_ID = 0x0001;
const ZIP64_EXTRA_VALUE_SIZE = 8;
const ZIP64_EXTRA_VALUE_ORDER = ['uncompressedSize', 'compressedSize', 'localOffset', 'diskStart'];
const ZIP64_SIZE_SENTINEL = 0xffffffff;
const ZIP64_COUNT_SENTINEL = 0xffff;

const EOCD_SIZE = 22;
const EOCD_SENTINEL_FIELDS = ['count', 'size', 'offset'];

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content ?? '', 'utf8');
}

function buildZip64Extra(spec, real) {
  if (!spec.zip64) return { extra: Buffer.alloc(0), sentinels: [] };
  const sentinels = ZIP64_EXTRA_VALUE_ORDER.filter((field) => field in spec.zip64);
  if (spec.omitZip64Extra) return { extra: Buffer.alloc(0), sentinels };
  const values = sentinels.map((field) => (spec.zip64[field] === true ? real[field] : spec.zip64[field]));
  const carried = spec.zip64ExtraValueCount ?? values.length;
  const extra = Buffer.alloc(4 + ZIP64_EXTRA_VALUE_SIZE * carried);
  extra.writeUInt16LE(ZIP64_EXTRA_HEADER_ID, 0);
  extra.writeUInt16LE(ZIP64_EXTRA_VALUE_SIZE * carried, 2);
  values.slice(0, carried).forEach((value, index) => {
    extra.writeBigUInt64LE(BigInt(value), 4 + index * ZIP64_EXTRA_VALUE_SIZE);
  });
  return { extra, sentinels };
}

function buildZip(specs, options = {}) {
  const comment = toBuffer(options.comment);
  const pieces = [];
  const centrals = [];
  let cursor = 0;

  for (const spec of specs) {
    const name = Buffer.from(spec.name, 'utf8');
    const raw = toBuffer(spec.content);
    const method = spec.method ?? (raw.length > 0 ? METHOD_DEFLATE : METHOD_STORED);
    const payload = method === METHOD_DEFLATE ? zlib.deflateRawSync(raw) : raw;
    const crc = raw.length === 0 ? 0 : zlib.crc32(raw);
    const flags = /[^\x00-\x7f]/.test(spec.name) ? UTF8_NAME_FLAG : 0;
    const { extra, sentinels } = buildZip64Extra(spec, {
      uncompressedSize: raw.length,
      compressedSize: payload.length,
      localOffset: cursor,
      diskStart: 0,
    });

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(sentinels.length > 0 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length + extra.length);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(sentinels.length > 0 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(spec.centralCrc ?? crc, 16);
    central.writeUInt32LE(spec.centralCompressedSize ?? payload.length, 20);
    central.writeUInt32LE(spec.centralUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(spec.name.endsWith('/') ? 0x10 : 0, 38);
    central.writeUInt32LE(spec.centralLocalOffset ?? cursor, 42);
    if (sentinels.includes('uncompressedSize')) central.writeUInt32LE(ZIP64_SIZE_SENTINEL, 24);
    if (sentinels.includes('compressedSize')) central.writeUInt32LE(ZIP64_SIZE_SENTINEL, 20);
    if (sentinels.includes('diskStart')) central.writeUInt16LE(ZIP64_COUNT_SENTINEL, 34);
    if (sentinels.includes('localOffset')) central.writeUInt32LE(ZIP64_SIZE_SENTINEL, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);

    pieces.push(local, payload);
    centrals.push(central);
    cursor += local.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const centralOffset = cursor;
  const sentinels = options.zip64 ? (options.zip64Sentinels ?? EOCD_SENTINEL_FIELDS) : [];
  const tail = [];

  if (options.zip64 && !options.omitZip64Locator) {
    const record = Buffer.alloc(ZIP64_EOCD_SIZE);
    record.writeUInt32LE(options.corruptZip64Record ? EOCD_SIGNATURE : ZIP64_EOCD_SIGNATURE, 0);
    record.writeBigUInt64LE(ZIP64_EOCD_REMAINING_SIZE, 4);
    record.writeUInt16LE(VERSION_NEEDED_ZIP64, 12);
    record.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
    record.writeUInt32LE(options.zip64DiskNumber ?? 0, 16);
    record.writeUInt32LE(options.zip64CentralStartDisk ?? 0, 20);
    record.writeBigUInt64LE(BigInt(options.zip64DiskEntryCount ?? options.zip64EntryCount ?? specs.length), 24);
    record.writeBigUInt64LE(BigInt(options.zip64EntryCount ?? specs.length), 32);
    record.writeBigUInt64LE(BigInt(options.zip64CentralSize ?? centralDirectory.length), 40);
    record.writeBigUInt64LE(BigInt(options.zip64CentralOffset ?? centralOffset), 48);

    const locator = Buffer.alloc(ZIP64_LOCATOR_SIZE);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
    locator.writeUInt32LE(options.zip64LocatorStartDisk ?? 0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralDirectory.length), 8);
    locator.writeUInt32LE(options.zip64DiskCount ?? 1, 16);

    tail.push(record, locator);
  }

  const eocdEntryCount = sentinels.includes('count')
    ? ZIP64_COUNT_SENTINEL
    : (options.entryCount ?? specs.length);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(eocdEntryCount, 8);
  eocd.writeUInt16LE(eocdEntryCount, 10);
  eocd.writeUInt32LE(sentinels.includes('size') ? ZIP64_SIZE_SENTINEL : centralDirectory.length, 12);
  eocd.writeUInt32LE(sentinels.includes('offset') ? ZIP64_SIZE_SENTINEL : centralOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([...pieces, centralDirectory, ...tail, eocd]);
}

function collect(buffer) {
  const seen = new Map();
  const result = eachEntry(buffer, (name, content) => {
    seen.set(name, content);
  });
  return { seen, result };
}

function signatureAt(buffer, signature) {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(signature, 0);
  return buffer.indexOf(needle);
}

function hasCode(code) {
  return (err) => {
    assert.equal(err.name, 'NubosPilotError', `expected a NubosPilotError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return true;
  };
}

test('ZIP-1 a single stored entry round-trips its exact content', () => {
  const content = '{"id":"NP-1","severity":"high"}';
  const zip = buildZip([{ name: 'advisory.json', content, method: METHOD_STORED }]);

  const entries = readEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'advisory.json');
  assert.equal(entries[0].method, METHOD_STORED);
  assert.equal(entries[0].uncompressedSize, Buffer.byteLength(content));
  assert.equal(entries[0].compressedSize, Buffer.byteLength(content));
  assert.equal(inflateEntry(zip, entries[0]).toString('utf8'), content);
});

test('ZIP-2 a single deflated entry round-trips its exact content', () => {
  const content = JSON.stringify({ id: 'NP-2', notes: 'x'.repeat(4096) });
  const zip = buildZip([{ name: 'advisory.json', content, method: METHOD_DEFLATE }]);

  const entries = readEntries(zip);
  assert.equal(entries[0].method, METHOD_DEFLATE);
  assert.ok(entries[0].compressedSize < entries[0].uncompressedSize, 'deflate should shrink a repetitive payload');
  assert.equal(inflateEntry(zip, entries[0]).toString('utf8'), content);
});

test('ZIP-3 multiple entries keep their own names and contents and eachEntry visits all', () => {
  const specs = [
    { name: 'a.json', content: '{"a":1}', method: METHOD_STORED },
    { name: 'nested/b.json', content: '{"b":' + '2'.repeat(500) + '}', method: METHOD_DEFLATE },
    { name: 'nested/deeper/c.txt', content: 'plain text', method: METHOD_STORED },
  ];
  const zip = buildZip(specs);

  assert.deepEqual(readEntries(zip).map((e) => e.name), specs.map((s) => s.name));

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 3, skipped: 0 });
  for (const spec of specs) {
    assert.equal(seen.get(spec.name).toString('utf8'), spec.content);
  }
});

test('ZIP-4 a directory entry is reported by readEntries but skipped by eachEntry', () => {
  const zip = buildZip([
    { name: 'records/', content: '', method: METHOD_STORED },
    { name: 'records/one.json', content: '{"one":true}', method: METHOD_STORED },
  ]);

  const entries = readEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'records/');
  assert.equal(entries[0].isDirectory, true);
  assert.equal(entries[1].isDirectory, false);

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 1, skipped: 1 });
  assert.deepEqual([...seen.keys()], ['records/one.json']);
});

test('ZIP-5 an empty file entry round-trips as an empty buffer', () => {
  const zip = buildZip([{ name: 'empty.json', content: '' }]);

  const entries = readEntries(zip);
  assert.equal(entries[0].uncompressedSize, 0);
  assert.equal(entries[0].isDirectory, false);

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 1, skipped: 0 });
  assert.equal(seen.get('empty.json').length, 0);
});

test('ZIP-6 the EOCD is still located behind a trailing archive comment', () => {
  const comment = 'nubos-pilot release bundle '.repeat(400);
  const zip = buildZip([{ name: 'a.json', content: '{"a":1}' }], { comment });
  assert.ok(comment.length > 1024, 'comment should be long enough to force a real backwards scan');

  const entries = readEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(inflateEntry(zip, entries[0]).toString('utf8'), '{"a":1}');
});

test('ZIP-7 a UTF-8 entry name with non-ASCII characters decodes correctly', () => {
  const name = 'berichte/größe-übersicht-日本語.json';
  const zip = buildZip([{ name, content: '{"ok":true}' }]);

  const entries = readEntries(zip);
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].utf8Name, true);

  const { seen } = collect(zip);
  assert.equal(seen.get(name).toString('utf8'), '{"ok":true}');
});

test('ZIP-8 an unsupported compression method throws zip-unsupported-method', () => {
  const zip = buildZip([{ name: 'lzma.json', content: 'not really lzma', method: 14 }]);

  const entries = readEntries(zip);
  assert.equal(entries[0].method, 14);
  assert.throws(() => inflateEntry(zip, entries[0]), hasCode('zip-unsupported-method'));
  assert.throws(() => inflateEntry(zip, entries[0]), /method 14/);
  assert.throws(() => eachEntry(zip, () => {}), hasCode('zip-unsupported-method'));
});

test('ZIP-9 a corrupted CRC throws zip-crc-mismatch', () => {
  const zip = buildZip([{ name: 'a.json', content: '{"a":1}', centralCrc: 0xdeadbeef }]);

  const entries = readEntries(zip);
  assert.equal(entries[0].crc32, 0xdeadbeef);
  assert.throws(() => inflateEntry(zip, entries[0]), hasCode('zip-crc-mismatch'));
  assert.throws(() => eachEntry(zip, () => {}), hasCode('zip-crc-mismatch'));
});

test('ZIP-10 a truncated archive with no EOCD throws a zip- error', () => {
  const zip = buildZip([{ name: 'a.json', content: '{"a":1}' }]);

  for (const truncated of [Buffer.alloc(0), zip.subarray(0, 8), zip.subarray(0, zip.length - 22)]) {
    assert.throws(() => readEntries(truncated), (err) => {
      assert.equal(err.name, 'NubosPilotError');
      assert.match(err.code, /^zip-/);
      return true;
    });
  }
  assert.throws(() => readEntries(zip.subarray(0, 8)), hasCode('zip-missing-eocd'));
});

test('ZIP-11 an out-of-bounds local header offset throws zip-corrupt-entry', () => {
  const farAway = buildZip([{ name: 'a.json', content: '{"a":1}', centralLocalOffset: 0x7fffff00 }]);
  assert.throws(() => readEntries(farAway), hasCode('zip-corrupt-entry'));

  const oversized = buildZip([{ name: 'a.json', content: '{"a":1}', centralCompressedSize: 0xffff0000 }]);
  assert.throws(() => readEntries(oversized), hasCode('zip-corrupt-entry'));
});

test('ZIP-12 a path-traversal entry name throws zip-unsafe-entry-name', () => {
  for (const name of ['../escape', 'a/../../escape.json', '/etc/passwd', 'C:/windows/system32']) {
    const zip = buildZip([{ name, content: 'x' }]);
    assert.throws(() => readEntries(zip), hasCode('zip-unsafe-entry-name'), name);
  }
});

test('ZIP-13 EOCD sentinels are resolved from the ZIP64 end-of-central-directory record', () => {
  const specs = [
    { name: 'zip64/a.json', content: '{"a":1}', method: METHOD_STORED },
    { name: 'zip64/b.json', content: JSON.stringify({ b: 'y'.repeat(2048) }), method: METHOD_DEFLATE },
    { name: 'zip64/c.txt', content: 'stored text', method: METHOD_STORED },
  ];
  const zip = buildZip(specs, { zip64: true });

  assert.equal(zip.readUInt16LE(zip.length - EOCD_SIZE + 10), 0xffff, 'entry count must be a sentinel');
  assert.equal(zip.readUInt32LE(zip.length - EOCD_SIZE + 12), 0xffffffff, 'central size must be a sentinel');
  assert.equal(zip.readUInt32LE(zip.length - EOCD_SIZE + 16), 0xffffffff, 'central offset must be a sentinel');

  const entries = readEntries(zip);
  assert.deepEqual(entries.map((e) => e.name), specs.map((s) => s.name));

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 3, skipped: 0 });
  for (const spec of specs) {
    assert.equal(seen.get(spec.name).toString('utf8'), spec.content, spec.name);
  }
});

test('ZIP-14 a callback that throws aborts eachEntry instead of being swallowed', () => {
  const zip = buildZip([
    { name: 'a.json', content: '{"a":1}' },
    { name: 'b.json', content: '{"b":2}' },
    { name: 'c.json', content: '{"c":3}' },
  ]);

  const visited = [];
  assert.throws(() => eachEntry(zip, (name) => {
    visited.push(name);
    if (name === 'b.json') throw new Error('caller exploded');
  }), /caller exploded/);
  assert.deepEqual(visited, ['a.json', 'b.json']);
});

test('ZIP-15 a 200-entry archive walks its central directory without mixing content', () => {
  const specs = [];
  for (let index = 0; index < 200; index++) {
    specs.push({
      name: `advisories/np-${String(index).padStart(4, '0')}.json`,
      content: JSON.stringify({ index, id: `NP-${index}`, filler: String(index).repeat(index % 40) }),
      method: index % 2 === 0 ? METHOD_DEFLATE : METHOD_STORED,
    });
  }
  const zip = buildZip(specs);

  const entries = readEntries(zip);
  assert.equal(entries.length, 200);

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 200, skipped: 0 });
  for (const spec of specs) {
    assert.equal(seen.get(spec.name).toString('utf8'), spec.content, spec.name);
    assert.equal(JSON.parse(seen.get(spec.name)).id, `NP-${JSON.parse(seen.get(spec.name)).index}`);
  }
});

test('ZIP-16 the table-driven CRC32 agrees with zlib.crc32', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('{"advisory":"NP-1"}'),
    Buffer.from('größe-übersicht-日本語', 'utf8'),
    Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)),
  ];
  for (const sample of samples) {
    assert.equal(_crc32(sample), zlib.crc32(sample), sample.length + '-byte sample');
  }
});

test('ZIP-17 a sentinel local-header offset is resolved from the 0x0001 extra field', () => {
  const content = JSON.stringify({ id: 'NP-17', payload: 'z'.repeat(600) });
  const specs = [
    { name: 'first.json', content: '{"first":true}', method: METHOD_STORED },
    { name: 'second.json', content, method: METHOD_DEFLATE, zip64: { localOffset: true } },
  ];

  for (const options of [{ zip64: true }, {}]) {
    const zip = buildZip(specs, options);
    const entries = readEntries(zip);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].name, 'second.json');
    assert.ok(entries[1].offset > 0, 'the real offset must come from the extra field, not the sentinel');
    assert.equal(zip.readUInt32LE(entries[1].offset), LOCAL_HEADER_SIGNATURE);
    assert.equal(inflateEntry(zip, entries[1]).toString('utf8'), content);
    assert.equal(inflateEntry(zip, entries[0]).toString('utf8'), '{"first":true}');
  }
});

test('ZIP-18 only the fields whose 32-bit slot is a sentinel are read from the extra field', () => {
  const content = 'x'.repeat(64);
  const zip = buildZip(
    [{ name: 'one-field.json', content, method: METHOD_STORED, zip64: { uncompressedSize: true } }],
    { zip64: true },
  );

  const centralAt = signatureAt(zip, CENTRAL_HEADER_SIGNATURE);
  assert.equal(zip.readUInt32LE(centralAt + 24), 0xffffffff, 'only the uncompressed size slot is a sentinel');
  assert.equal(zip.readUInt32LE(centralAt + 20), content.length, 'the compressed size slot keeps its 32-bit value');
  assert.equal(zip.readUInt32LE(centralAt + 42), 0, 'the local offset slot keeps its 32-bit value');
  assert.equal(zip.readUInt16LE(centralAt + 30), 4 + 8, 'the extra field carries exactly one 64-bit value');

  const entries = readEntries(zip);
  assert.equal(entries[0].uncompressedSize, content.length);
  assert.equal(entries[0].compressedSize, content.length);
  assert.equal(entries[0].offset, 0);
  assert.equal(inflateEntry(zip, entries[0]).toString('utf8'), content);
});

test('ZIP-19 more than 65535 entries are reported through the ZIP64 entry count', () => {
  const total = 65600;
  const specs = [];
  for (let index = 0; index < total; index++) {
    specs.push({ name: `e/${index.toString(36)}`, content: '', method: METHOD_STORED });
  }
  const zip = buildZip(specs, { zip64: true });
  assert.equal(zip.readUInt16LE(zip.length - EOCD_SIZE + 10), 0xffff);

  const entries = readEntries(zip);
  assert.equal(entries.length, total);
  assert.ok(total > 0xffff, 'the archive must exceed what a 16-bit count can express');
  assert.equal(entries[0].name, 'e/0');
  assert.equal(entries[0xffff].name, `e/${(0xffff).toString(36)}`);
  assert.equal(entries[total - 1].name, `e/${(total - 1).toString(36)}`);
  assert.equal(inflateEntry(zip, entries[total - 1]).length, 0);
  assert.equal(new Set(entries.map((e) => e.name)).size, total);
});

test('ZIP-20 a ZIP64 value beyond Number.MAX_SAFE_INTEGER is refused, not truncated', () => {
  const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const plain = [{ name: 'a.json', content: '{"a":1}' }];

  const hugeCentralOffset = buildZip(plain, { zip64: true, zip64CentralOffset: beyond });
  assert.throws(() => readEntries(hugeCentralOffset), hasCode('zip-zip64-value-too-large'));
  assert.throws(() => readEntries(hugeCentralOffset), /9007199254740992/);

  const hugeCentralSize = buildZip(plain, { zip64: true, zip64CentralSize: 2n ** 54n });
  assert.throws(() => readEntries(hugeCentralSize), hasCode('zip-zip64-value-too-large'));

  const hugeEntryCount = buildZip(plain, { zip64: true, zip64EntryCount: 2n ** 60n });
  assert.throws(() => readEntries(hugeEntryCount), hasCode('zip-zip64-value-too-large'));

  const hugeRecordOffset = buildZip(plain, { zip64: true });
  hugeRecordOffset.writeBigUInt64LE(beyond, hugeRecordOffset.length - EOCD_SIZE - 20 + 8);
  assert.throws(() => readEntries(hugeRecordOffset), hasCode('zip-zip64-value-too-large'));

  const hugeEntryOffset = buildZip(
    [{ name: 'a.json', content: '{"a":1}', zip64: { localOffset: 2n ** 55n } }],
    { zip64: true },
  );
  assert.throws(() => readEntries(hugeEntryOffset), hasCode('zip-zip64-value-too-large'));
});

test('ZIP-21 EOCD sentinels without a readable ZIP64 record are refused with a zip- error', () => {
  const noLocator = buildZip([{ name: 'a.json', content: '{"a":1}' }], { zip64: true, omitZip64Locator: true });
  assert.throws(() => readEntries(noLocator), hasCode('zip-zip64-locator-missing'));

  const corruptRecord = buildZip([{ name: 'a.json', content: '{"a":1}' }], { zip64: true, corruptZip64Record: true });
  assert.throws(() => readEntries(corruptRecord), hasCode('zip-corrupt-zip64-eocd'));

  const onlyCountSentinel = buildZip([{ name: 'a.json', content: 'x' }], { entryCount: 0xffff });
  assert.throws(() => readEntries(onlyCountSentinel), hasCode('zip-zip64-locator-missing'));
});

test('ZIP-22 a spanned ZIP64 archive is still refused with zip-zip64-unsupported', () => {
  const plain = [{ name: 'a.json', content: '{"a":1}' }];

  const manyDisks = buildZip(plain, { zip64: true, zip64DiskCount: 2 });
  assert.throws(() => readEntries(manyDisks), hasCode('zip-zip64-unsupported'));

  const locatorOnOtherDisk = buildZip(plain, { zip64: true, zip64LocatorStartDisk: 1 });
  assert.throws(() => readEntries(locatorOnOtherDisk), hasCode('zip-zip64-unsupported'));

  const centralOnOtherDisk = buildZip(plain, { zip64: true, zip64CentralStartDisk: 1 });
  assert.throws(() => readEntries(centralOnOtherDisk), hasCode('zip-zip64-unsupported'));

  const partialDisk = buildZip(
    [{ name: 'a.json', content: '{"a":1}' }, { name: 'b.json', content: '{"b":2}' }],
    { zip64: true, zip64DiskEntryCount: 1 },
  );
  assert.throws(() => readEntries(partialDisk), hasCode('zip-zip64-unsupported'));

  const entryOnOtherDisk = buildZip(
    [{ name: 'a.json', content: '{"a":1}', zip64: { diskStart: 3 } }],
    { zip64: true },
  );
  assert.throws(() => readEntries(entryOnOtherDisk), hasCode('zip-zip64-unsupported'));
});

test('ZIP-23 entry sentinels without usable ZIP64 extra data are refused with a zip- error', () => {
  const noExtraForSize = buildZip([{ name: 'huge.json', content: 'x', centralUncompressedSize: 0xffffffff }]);
  assert.throws(() => readEntries(noExtraForSize), hasCode('zip-zip64-extra-missing'));

  const noExtraForOffset = buildZip([{ name: 'huge.json', content: 'x', centralLocalOffset: 0xffffffff }]);
  assert.throws(() => readEntries(noExtraForOffset), hasCode('zip-zip64-extra-missing'));

  const droppedExtra = buildZip(
    [{ name: 'huge.json', content: 'x', zip64: { localOffset: true }, omitZip64Extra: true }],
    { zip64: true },
  );
  assert.throws(() => readEntries(droppedExtra), hasCode('zip-zip64-extra-missing'));

  const truncatedExtra = buildZip(
    [{
      name: 'huge.json',
      content: 'x'.repeat(40),
      method: METHOD_STORED,
      zip64: { uncompressedSize: true, compressedSize: true, localOffset: true },
      zip64ExtraValueCount: 2,
    }],
    { zip64: true },
  );
  assert.throws(() => readEntries(truncatedExtra), hasCode('zip-zip64-extra-truncated'));
});

test('ZIP-24 a plain archive stays free of ZIP64 structures and reads unchanged', () => {
  const specs = [
    { name: 'plain/a.json', content: '{"a":1}', method: METHOD_STORED },
    { name: 'plain/b.txt', content: 'no zip64 here', method: METHOD_STORED },
  ];
  const zip = buildZip(specs);

  assert.equal(signatureAt(zip, ZIP64_EOCD_SIGNATURE), -1, 'no ZIP64 end-of-central-directory record');
  assert.equal(signatureAt(zip, ZIP64_LOCATOR_SIGNATURE), -1, 'no ZIP64 locator');
  assert.equal(zip.readUInt16LE(zip.length - EOCD_SIZE + 10), specs.length);
  assert.notEqual(zip.readUInt32LE(zip.length - EOCD_SIZE + 12), 0xffffffff);
  assert.notEqual(zip.readUInt32LE(zip.length - EOCD_SIZE + 16), 0xffffffff);

  const { seen, result } = collect(zip);
  assert.deepEqual(result, { entries: 2, skipped: 0 });
  for (const spec of specs) {
    assert.equal(seen.get(spec.name).toString('utf8'), spec.content, spec.name);
  }
});

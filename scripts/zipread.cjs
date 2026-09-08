'use strict';

const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');
const { NubosPilotError } = require('../lib/core.cjs');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;

const MAX_EOCD_COMMENT_LENGTH = 0xffff;
const EOCD_SCAN_WINDOW = MAX_EOCD_COMMENT_LENGTH + EOCD_SIZE;

const EOCD_ENTRY_COUNT_OFFSET = 10;
const EOCD_CENTRAL_SIZE_OFFSET = 12;
const EOCD_CENTRAL_OFFSET_OFFSET = 16;
const EOCD_COMMENT_LENGTH_OFFSET = 20;

const CENTRAL_FLAGS_OFFSET = 8;
const CENTRAL_METHOD_OFFSET = 10;
const CENTRAL_CRC32_OFFSET = 16;
const CENTRAL_COMPRESSED_SIZE_OFFSET = 20;
const CENTRAL_UNCOMPRESSED_SIZE_OFFSET = 24;
const CENTRAL_NAME_LENGTH_OFFSET = 28;
const CENTRAL_EXTRA_LENGTH_OFFSET = 30;
const CENTRAL_COMMENT_LENGTH_OFFSET = 32;
const CENTRAL_DISK_START_OFFSET = 34;
const CENTRAL_LOCAL_OFFSET_OFFSET = 42;

const LOCAL_NAME_LENGTH_OFFSET = 26;
const LOCAL_EXTRA_LENGTH_OFFSET = 28;

const ZIP64_LOCATOR_START_DISK_OFFSET = 4;
const ZIP64_LOCATOR_RECORD_OFFSET_OFFSET = 8;
const ZIP64_LOCATOR_DISK_COUNT_OFFSET = 16;

const ZIP64_EOCD_DISK_NUMBER_OFFSET = 16;
const ZIP64_EOCD_CENTRAL_START_DISK_OFFSET = 20;
const ZIP64_EOCD_DISK_ENTRY_COUNT_OFFSET = 24;
const ZIP64_EOCD_ENTRY_COUNT_OFFSET = 32;
const ZIP64_EOCD_CENTRAL_SIZE_OFFSET = 40;
const ZIP64_EOCD_CENTRAL_OFFSET_OFFSET = 48;

const EXTRA_FIELD_HEADER_SIZE = 4;
const EXTRA_FIELD_DATA_SIZE_OFFSET = 2;
const ZIP64_EXTRA_HEADER_ID = 0x0001;
const ZIP64_EXTRA_VALUE_SIZE = 8;
const ZIP64_EXTRA_VALUE_ORDER = ['uncompressedSize', 'compressedSize', 'localOffset', 'diskStart'];

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ZIP64_SIZE_SENTINEL = 0xffffffff;
const ZIP64_COUNT_SENTINEL = 0xffff;
const ZIP64_DISK_SENTINEL = 0xffff;

const ONLY_DISK_NUMBER = 0;
const ONLY_DISK_COUNT = 1;

const MAX_SAFE_UINT64 = BigInt(Number.MAX_SAFE_INTEGER);

const UTF8_NAME_FLAG = 0x0800;

const CRC32_POLYNOMIAL = 0xedb88320;

let crc32Table = null;

function crc32Lookup() {
  if (crc32Table) return crc32Table;
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ CRC32_POLYNOMIAL : value >>> 1;
    }
    table[byte] = value >>> 0;
  }
  crc32Table = table;
  return crc32Table;
}

function crc32(buffer) {
  const table = crc32Lookup();
  let crc = 0xffffffff;
  for (let at = 0; at < buffer.length; at++) {
    crc = table[(crc ^ buffer[at]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function requireBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new NubosPilotError('zip-invalid-input', 'A ZIP archive must be supplied as a Buffer', {
      received: buffer === null ? 'null' : typeof buffer,
    });
  }
  return buffer;
}

function requireRange(buffer, at, length, what) {
  if (!Number.isInteger(at) || at < 0 || length < 0 || at + length > buffer.length) {
    throw new NubosPilotError('zip-corrupt-entry', `${what} lies outside the ${buffer.length}-byte archive`, {
      offset: at,
      length,
      archiveSize: buffer.length,
    });
  }
}

function locateEndOfCentralDirectory(buffer) {
  if (buffer.length < EOCD_SIZE) {
    throw new NubosPilotError(
      'zip-missing-eocd',
      `Archive of ${buffer.length} bytes is too short to hold an end-of-central-directory record`,
      { archiveSize: buffer.length },
    );
  }
  const earliest = Math.max(0, buffer.length - EOCD_SCAN_WINDOW);
  for (let at = buffer.length - EOCD_SIZE; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(at + EOCD_COMMENT_LENGTH_OFFSET);
    if (at + EOCD_SIZE + commentLength <= buffer.length) return at;
  }
  throw new NubosPilotError(
    'zip-missing-eocd',
    'No end-of-central-directory signature found in the last 64 KiB of the archive',
    { archiveSize: buffer.length },
  );
}

function readSafeUInt64(buffer, at, what) {
  requireRange(buffer, at, ZIP64_EXTRA_VALUE_SIZE, what);
  const value = buffer.readBigUInt64LE(at);
  if (value > MAX_SAFE_UINT64) {
    throw new NubosPilotError(
      'zip-zip64-value-too-large',
      `${what} is ${value}, beyond the ${Number.MAX_SAFE_INTEGER} bytes this reader can address without losing precision`,
      { offset: at, value: value.toString(), limit: Number.MAX_SAFE_INTEGER },
    );
  }
  return Number(value);
}

function readZip64EndOfCentralDirectory(buffer, eocdAt) {
  const locatorAt = eocdAt - ZIP64_LOCATOR_SIZE;
  if (locatorAt < 0 || buffer.readUInt32LE(locatorAt) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new NubosPilotError(
      'zip-zip64-locator-missing',
      'The end-of-central-directory record carries ZIP64 sentinels but no ZIP64 locator precedes it',
      { eocdOffset: eocdAt, locatorOffset: locatorAt },
    );
  }
  const locatorStartDisk = buffer.readUInt32LE(locatorAt + ZIP64_LOCATOR_START_DISK_OFFSET);
  const diskCount = buffer.readUInt32LE(locatorAt + ZIP64_LOCATOR_DISK_COUNT_OFFSET);
  if (locatorStartDisk !== ONLY_DISK_NUMBER || diskCount !== ONLY_DISK_COUNT) {
    throw new NubosPilotError(
      'zip-zip64-unsupported',
      `ZIP64 archive spans ${diskCount} disks with its end-of-central-directory record on disk ${locatorStartDisk}; only single-disk archives can be read`,
      { locatorStartDisk, diskCount },
    );
  }

  const recordAt = readSafeUInt64(
    buffer,
    locatorAt + ZIP64_LOCATOR_RECORD_OFFSET_OFFSET,
    'The ZIP64 end-of-central-directory offset',
  );
  requireRange(buffer, recordAt, ZIP64_EOCD_SIZE, 'The ZIP64 end-of-central-directory record');
  const signature = buffer.readUInt32LE(recordAt);
  if (signature !== ZIP64_EOCD_SIGNATURE) {
    throw new NubosPilotError(
      'zip-corrupt-zip64-eocd',
      `Expected a ZIP64 end-of-central-directory record at offset ${recordAt}, found signature 0x${signature.toString(16)}`,
      { offset: recordAt, signature },
    );
  }

  const diskNumber = buffer.readUInt32LE(recordAt + ZIP64_EOCD_DISK_NUMBER_OFFSET);
  const centralStartDisk = buffer.readUInt32LE(recordAt + ZIP64_EOCD_CENTRAL_START_DISK_OFFSET);
  const diskEntryCount = readSafeUInt64(
    buffer,
    recordAt + ZIP64_EOCD_DISK_ENTRY_COUNT_OFFSET,
    'The ZIP64 entry count of this disk',
  );
  const entryCount = readSafeUInt64(
    buffer,
    recordAt + ZIP64_EOCD_ENTRY_COUNT_OFFSET,
    'The ZIP64 total entry count',
  );
  if (diskNumber !== ONLY_DISK_NUMBER || centralStartDisk !== ONLY_DISK_NUMBER || diskEntryCount !== entryCount) {
    throw new NubosPilotError(
      'zip-zip64-unsupported',
      `ZIP64 archive is spanned: record on disk ${diskNumber}, central directory starting on disk ${centralStartDisk}, ${diskEntryCount} of ${entryCount} entries on this disk`,
      { diskNumber, centralStartDisk, diskEntryCount, entryCount },
    );
  }

  const centralSize = readSafeUInt64(
    buffer,
    recordAt + ZIP64_EOCD_CENTRAL_SIZE_OFFSET,
    'The ZIP64 central directory size',
  );
  const centralOffset = readSafeUInt64(
    buffer,
    recordAt + ZIP64_EOCD_CENTRAL_OFFSET_OFFSET,
    'The ZIP64 central directory offset',
  );
  return { entryCount, centralSize, centralOffset };
}

function readEndOfCentralDirectory(buffer) {
  const at = locateEndOfCentralDirectory(buffer);
  const declaredEntryCount = buffer.readUInt16LE(at + EOCD_ENTRY_COUNT_OFFSET);
  const declaredCentralSize = buffer.readUInt32LE(at + EOCD_CENTRAL_SIZE_OFFSET);
  const declaredCentralOffset = buffer.readUInt32LE(at + EOCD_CENTRAL_OFFSET_OFFSET);
  const usesZip64 = declaredEntryCount === ZIP64_COUNT_SENTINEL
    || declaredCentralSize === ZIP64_SIZE_SENTINEL
    || declaredCentralOffset === ZIP64_SIZE_SENTINEL;

  const { entryCount, centralSize, centralOffset } = usesZip64
    ? readZip64EndOfCentralDirectory(buffer, at)
    : {
      entryCount: declaredEntryCount,
      centralSize: declaredCentralSize,
      centralOffset: declaredCentralOffset,
    };

  requireRange(buffer, centralOffset, centralSize, 'The central directory');
  return { entryCount, centralSize, centralOffset };
}

function decodeName(buffer, at, length) {
  requireRange(buffer, at, length, 'An entry name');
  return buffer.toString('utf8', at, at + length);
}

function assertSafeName(name) {
  const isAbsolute = name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(name);
  const hasParentSegment = name.split(/[/\\]/).some((segment) => segment === '..');
  if (isAbsolute || hasParentSegment) {
    throw new NubosPilotError('zip-unsafe-entry-name', `Refusing entry with unsafe name "${name}"`, { name });
  }
}

function findZip64ExtraField(buffer, at, length, name) {
  requireRange(buffer, at, length, `The extra field of entry "${name}"`);
  const end = at + length;
  let cursor = at;
  while (cursor + EXTRA_FIELD_HEADER_SIZE <= end) {
    const headerId = buffer.readUInt16LE(cursor);
    const dataSize = buffer.readUInt16LE(cursor + EXTRA_FIELD_DATA_SIZE_OFFSET);
    const dataAt = cursor + EXTRA_FIELD_HEADER_SIZE;
    if (dataAt + dataSize > end) {
      throw new NubosPilotError(
        'zip-corrupt-extra-field',
        `Extra field 0x${headerId.toString(16)} of entry "${name}" declares ${dataSize} bytes that overrun the extra field`,
        { name, headerId, dataSize },
      );
    }
    if (headerId === ZIP64_EXTRA_HEADER_ID) return { at: dataAt, size: dataSize };
    cursor = dataAt + dataSize;
  }
  return null;
}

function sentinelFor(field) {
  return field === 'diskStart' ? ZIP64_DISK_SENTINEL : ZIP64_SIZE_SENTINEL;
}

function resolveZip64Fields(buffer, extraAt, extraLength, declared, name) {
  const sentinelFields = ZIP64_EXTRA_VALUE_ORDER.filter((field) => declared[field] === sentinelFor(field));
  if (sentinelFields.length === 0) return declared;

  const extra = findZip64ExtraField(buffer, extraAt, extraLength, name);
  if (!extra) {
    throw new NubosPilotError(
      'zip-zip64-extra-missing',
      `Entry "${name}" carries ZIP64 sentinels for ${sentinelFields.join(', ')} but no 0x0001 extra field supplies the 64-bit values`,
      { name, fields: sentinelFields },
    );
  }

  const resolved = { ...declared };
  const end = extra.at + extra.size;
  let cursor = extra.at;
  for (const field of sentinelFields) {
    if (cursor + ZIP64_EXTRA_VALUE_SIZE > end) {
      throw new NubosPilotError(
        'zip-zip64-extra-truncated',
        `The ${extra.size}-byte ZIP64 extra field of entry "${name}" ends before supplying ${field}`,
        { name, field, extraSize: extra.size, fields: sentinelFields },
      );
    }
    resolved[field] = readSafeUInt64(buffer, cursor, `The ZIP64 ${field} of entry "${name}"`);
    cursor += ZIP64_EXTRA_VALUE_SIZE;
  }
  return resolved;
}

function readCentralEntry(buffer, at) {
  requireRange(buffer, at, CENTRAL_HEADER_SIZE, 'A central directory header');
  const signature = buffer.readUInt32LE(at);
  if (signature !== CENTRAL_HEADER_SIGNATURE) {
    throw new NubosPilotError(
      'zip-corrupt-central-directory',
      `Expected a central directory header at offset ${at}, found signature 0x${signature.toString(16)}`,
      { offset: at, signature },
    );
  }
  const flags = buffer.readUInt16LE(at + CENTRAL_FLAGS_OFFSET);
  const method = buffer.readUInt16LE(at + CENTRAL_METHOD_OFFSET);
  const storedCrc32 = buffer.readUInt32LE(at + CENTRAL_CRC32_OFFSET);
  const compressedSize = buffer.readUInt32LE(at + CENTRAL_COMPRESSED_SIZE_OFFSET);
  const uncompressedSize = buffer.readUInt32LE(at + CENTRAL_UNCOMPRESSED_SIZE_OFFSET);
  const nameLength = buffer.readUInt16LE(at + CENTRAL_NAME_LENGTH_OFFSET);
  const extraLength = buffer.readUInt16LE(at + CENTRAL_EXTRA_LENGTH_OFFSET);
  const commentLength = buffer.readUInt16LE(at + CENTRAL_COMMENT_LENGTH_OFFSET);
  const diskStart = buffer.readUInt16LE(at + CENTRAL_DISK_START_OFFSET);
  const localOffset = buffer.readUInt32LE(at + CENTRAL_LOCAL_OFFSET_OFFSET);
  const name = decodeName(buffer, at + CENTRAL_HEADER_SIZE, nameLength);

  const resolved = resolveZip64Fields(
    buffer,
    at + CENTRAL_HEADER_SIZE + nameLength,
    extraLength,
    { uncompressedSize, compressedSize, localOffset, diskStart },
    name,
  );
  if (diskStart === ZIP64_DISK_SENTINEL && resolved.diskStart !== ONLY_DISK_NUMBER) {
    throw new NubosPilotError(
      'zip-zip64-unsupported',
      `Entry "${name}" lives on disk ${resolved.diskStart} of a spanned ZIP64 archive; only single-disk archives can be read`,
      { name, diskStart: resolved.diskStart },
    );
  }
  assertSafeName(name);
  requireRange(buffer, resolved.localOffset, LOCAL_HEADER_SIZE, `The local header of entry "${name}"`);
  requireRange(buffer, resolved.localOffset, resolved.compressedSize, `The compressed data of entry "${name}"`);

  const entry = {
    name,
    compressedSize: resolved.compressedSize,
    uncompressedSize: resolved.uncompressedSize,
    method,
    offset: resolved.localOffset,
    crc32: storedCrc32,
    isDirectory: name.endsWith('/') || name.endsWith('\\'),
    utf8Name: (flags & UTF8_NAME_FLAG) !== 0,
  };
  const nextHeaderAt = at + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  return { entry, nextHeaderAt };
}

function readEntries(buffer) {
  requireBuffer(buffer);
  const { entryCount, centralOffset, centralSize } = readEndOfCentralDirectory(buffer);
  const centralEnd = centralOffset + centralSize;
  const entries = [];
  let at = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (at >= centralEnd) {
      throw new NubosPilotError(
        'zip-corrupt-central-directory',
        `Central directory declares ${entryCount} entries but ran out of bytes after ${index}`,
        { declared: entryCount, found: index },
      );
    }
    const { entry, nextHeaderAt } = readCentralEntry(buffer, at);
    entries.push(entry);
    at = nextHeaderAt;
  }
  return entries;
}

function locateEntryData(buffer, entry) {
  const at = entry.offset;
  requireRange(buffer, at, LOCAL_HEADER_SIZE, `The local header of entry "${entry.name}"`);
  const signature = buffer.readUInt32LE(at);
  if (signature !== LOCAL_HEADER_SIGNATURE) {
    throw new NubosPilotError(
      'zip-corrupt-entry',
      `Expected a local file header for "${entry.name}" at offset ${at}, found signature 0x${signature.toString(16)}`,
      { name: entry.name, offset: at, signature },
    );
  }
  const nameLength = buffer.readUInt16LE(at + LOCAL_NAME_LENGTH_OFFSET);
  const extraLength = buffer.readUInt16LE(at + LOCAL_EXTRA_LENGTH_OFFSET);
  const dataStart = at + LOCAL_HEADER_SIZE + nameLength + extraLength;
  requireRange(buffer, dataStart, entry.compressedSize, `The compressed data of entry "${entry.name}"`);
  return dataStart;
}

function inflateEntry(buffer, entry) {
  requireBuffer(buffer);
  if (!entry || typeof entry.offset !== 'number') {
    throw new NubosPilotError('zip-invalid-input', 'inflateEntry needs an entry object from readEntries', {
      received: entry === null ? 'null' : typeof entry,
    });
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw new NubosPilotError(
      'zip-unsupported-method',
      `Entry "${entry.name}" uses compression method ${entry.method}; only 0 (stored) and 8 (deflate) are supported`,
      { name: entry.name, method: entry.method },
    );
  }
  const dataStart = locateEntryData(buffer, entry);
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  let content;
  if (entry.method === METHOD_STORED) {
    content = Buffer.from(compressed);
  } else {
    try {
      content = zlib.inflateRawSync(compressed);
    } catch (cause) {
      throw new NubosPilotError('zip-inflate-failed', `Could not inflate entry "${entry.name}": ${cause.message}`, {
        name: entry.name,
        cause: cause.message,
      });
    }
  }

  if (content.length !== entry.uncompressedSize) {
    throw new NubosPilotError(
      'zip-size-mismatch',
      `Entry "${entry.name}" declares ${entry.uncompressedSize} bytes but decoded to ${content.length}`,
      { name: entry.name, declared: entry.uncompressedSize, actual: content.length },
    );
  }

  const actualCrc32 = crc32(content);
  if (actualCrc32 !== entry.crc32) {
    throw new NubosPilotError(
      'zip-crc-mismatch',
      `Entry "${entry.name}" failed its CRC32 check (expected 0x${entry.crc32.toString(16)}, got 0x${actualCrc32.toString(16)})`,
      { name: entry.name, expected: entry.crc32, actual: actualCrc32 },
    );
  }
  return content;
}

function eachEntry(buffer, callback) {
  if (typeof callback !== 'function') {
    throw new NubosPilotError('zip-invalid-input', 'eachEntry needs a callback function', {
      received: typeof callback,
    });
  }
  const all = readEntries(buffer);
  let entries = 0;
  let skipped = 0;
  for (const entry of all) {
    if (entry.isDirectory) {
      skipped++;
      continue;
    }
    const content = inflateEntry(buffer, entry);
    callback(entry.name, content);
    entries++;
  }
  return { entries, skipped };
}

module.exports = { readEntries, eachEntry, inflateEntry, _crc32: crc32 };

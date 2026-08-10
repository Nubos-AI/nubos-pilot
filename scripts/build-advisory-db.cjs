'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { NubosPilotError, atomicWriteFileSync } = require('../lib/core.cjs');
const compact = require('./advisory-compact.cjs');
const zipread = require('./zipread.cjs');

const FEEDS = Object.freeze([
  { eco: 'npm', url: 'https://storage.googleapis.com/osv-vulnerabilities/npm/all.zip', license: 'CC-BY-4.0' },
  { eco: 'PyPI', url: 'https://storage.googleapis.com/osv-vulnerabilities/PyPI/all.zip', license: 'CC-BY-4.0' },
  { eco: 'Go', url: 'https://storage.googleapis.com/osv-vulnerabilities/Go/all.zip', license: 'CC-BY-4.0' },
  { eco: 'crates.io', url: 'https://storage.googleapis.com/osv-vulnerabilities/crates.io/all.zip', license: 'CC0-1.0' },
  { eco: 'Maven', url: 'https://storage.googleapis.com/osv-vulnerabilities/Maven/all.zip', license: 'CC-BY-4.0' },
  { eco: 'Packagist', url: 'https://storage.googleapis.com/osv-vulnerabilities/Packagist/all.zip', license: 'CC-BY-4.0' },
  { eco: 'RubyGems', url: 'https://storage.googleapis.com/osv-vulnerabilities/RubyGems/all.zip', license: 'CC-BY-4.0' },
  { eco: 'NuGet', url: 'https://storage.googleapis.com/osv-vulnerabilities/NuGet/all.zip', license: 'CC-BY-4.0' },
]);

const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'lib', 'scan', 'data');
const FETCH_TIMEOUT_MS = 120000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const GZIP_LEVEL = 9;

function assertFeedLicenses(feeds) {
  for (const feed of feeds) {
    if (!compact.isLicenseAllowed(feed.license)) {
      throw new NubosPilotError(
        'advisory-build-license-refused',
        'feed ' + feed.eco + ' declares license ' + feed.license + ', which is not on the redistribution allowlist',
        { eco: feed.eco, license: feed.license, allowlist: compact.LICENSE_ALLOWLIST },
      );
    }
  }
  return feeds;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fetchBuffer(url, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : FETCH_TIMEOUT_MS;
  const maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : MAX_ARCHIVE_BYTES;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        reject(new NubosPilotError('advisory-build-redirect', 'refusing to follow a redirect for ' + url, {
          url, location: res.headers.location, status: res.statusCode,
        }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new NubosPilotError('advisory-build-fetch-failed', 'GET ' + url + ' returned ' + res.statusCode, {
          url, status: res.statusCode,
        }));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new NubosPilotError('advisory-build-archive-too-large', url + ' exceeded ' + maxBytes + ' bytes', { url, maxBytes }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new NubosPilotError('advisory-build-timeout', 'GET ' + url + ' timed out after ' + timeoutMs + ' ms', { url, timeoutMs }));
    });
    req.on('error', reject);
  });
}

function recordsFromArchive(buffer) {
  const records = [];
  let malformed = 0;
  zipread.eachEntry(buffer, (name, content) => {
    if (!name.endsWith('.json')) return;
    try { records.push(JSON.parse(content.toString('utf-8'))); }
    catch { malformed += 1; }
  });
  return { records, malformed };
}

function writeShards(outDir, built, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const sha = {};
  const ecosystems = {};

  const ecoNames = new Set([...built.vuln.keys(), ...built.malicious.keys()]);
  for (const eco of [...ecoNames].sort()) {
    const entry = { advisories: 0, malicious: 0 };

    const vulnShard = built.vuln.get(eco);
    if (vulnShard && vulnShard.size) {
      const body = zlib.gzipSync(Buffer.from(compact.renderVulnShard(vulnShard), 'utf-8'), { level: GZIP_LEVEL });
      const file = 'vuln-' + eco + '.json.gz';
      atomicWriteFileSync(path.join(outDir, file), body, null, 0o644);
      sha[file] = sha256(body);
      entry.advisories = [...vulnShard.values()].reduce((n, list) => n + list.length, 0);
    }

    const malShard = built.malicious.get(eco);
    if (malShard && malShard.size) {
      const body = zlib.gzipSync(Buffer.from(compact.renderMaliciousShard(malShard), 'utf-8'), { level: GZIP_LEVEL });
      const file = 'malicious-' + eco + '.txt.gz';
      atomicWriteFileSync(path.join(outDir, file), body, null, 0o644);
      sha[file] = sha256(body);
      entry.malicious = malShard.size;
    }

    ecosystems[eco] = entry;
  }

  const manifest = {
    schema_version: compact.SCHEMA_VERSION,
    generated_at: meta.generatedAt,
    tool_version: meta.toolVersion,
    ecosystems,
    sources: meta.feeds.map((f) => ({ name: f.eco, license: f.license })),
    sha256: sha,
  };
  atomicWriteFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
    0o644,
  );
  return manifest;
}

async function build(opts) {
  const o = opts || {};
  const feeds = assertFeedLicenses(o.feeds || FEEDS);
  const outDir = o.outDir || DEFAULT_OUT_DIR;
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetchBuffer;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const generatedAt = typeof o.generatedAt === 'string' && o.generatedAt
    ? o.generatedAt
    : new Date().toISOString();

  const allRecords = [];
  const perFeed = [];
  const failed = [];
  for (const feed of feeds) {
    log('fetching ' + feed.eco);
    try {
      const archive = await fetchImpl(feed.url, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes });
      const { records, malformed } = recordsFromArchive(archive);
      perFeed.push({ eco: feed.eco, records: records.length, malformed, archive_bytes: archive.length });
      log('  ' + feed.eco + ': ' + records.length + ' records' + (malformed ? ', ' + malformed + ' malformed' : ''));
      allRecords.push(...records);
    } catch (err) {
      const reason = (err && err.code) || (err && err.message) || 'unknown';
      failed.push({ eco: feed.eco, reason });
      perFeed.push({ eco: feed.eco, records: 0, malformed: 0, archive_bytes: 0, failed: reason });
      log('  ' + feed.eco + ': FAILED (' + reason + ')');
    }
  }

  if (failed.length === feeds.length) {
    throw new NubosPilotError(
      'advisory-build-all-feeds-failed',
      'every feed failed, refusing to write an empty snapshot',
      { failed },
    );
  }
  if (failed.length && o.requireAllFeeds !== false) {
    throw new NubosPilotError(
      'advisory-build-feed-failed',
      failed.length + ' of ' + feeds.length + ' feeds failed: '
        + failed.map((f) => f.eco + ' (' + f.reason + ')').join(', ')
        + ' — pass requireAllFeeds:false to ship a partial snapshot on purpose',
      { failed },
    );
  }

  const built = compact.buildShards(allRecords);
  const manifest = writeShards(outDir, built, {
    generatedAt,
    toolVersion: o.toolVersion || 'unknown',
    feeds: feeds.filter((f) => !failed.some((x) => x.eco === f.eco)),
  });

  return { manifest, stats: built.stats, feeds: perFeed, failed, outDir };
}

function verifyOnDisk(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
  catch {
    return { ok: false, reason: 'manifest-unreadable', mismatches: [], missing: ['manifest.json'] };
  }
  const mismatches = [];
  const missing = [];
  for (const [file, expected] of Object.entries(manifest.sha256 || {})) {
    let body;
    try { body = fs.readFileSync(path.join(outDir, file)); }
    catch { missing.push(file); continue; }
    if (sha256(body) !== expected) mismatches.push(file);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing, manifest };
}

module.exports = {
  FEEDS,
  DEFAULT_OUT_DIR,
  MAX_ARCHIVE_BYTES,
  assertFeedLicenses,
  sha256,
  fetchBuffer,
  recordsFromArchive,
  writeShards,
  build,
  verifyOnDisk,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outDir = DEFAULT_OUT_DIR;
  if (argv.includes('--check')) {
    const result = verifyOnDisk(outDir);
    if (!result.ok) {
      process.stderr.write('advisory db check FAILED\n'
        + (result.reason ? '  reason: ' + result.reason + '\n' : '')
        + (result.mismatches.length ? '  mismatched: ' + result.mismatches.join(', ') + '\n' : '')
        + (result.missing.length ? '  missing: ' + result.missing.join(', ') + '\n' : ''));
      process.exit(1);
    }
    process.stdout.write('advisory db check ok: ' + Object.keys(result.manifest.sha256 || {}).length + ' shards verified\n');
    process.exit(0);
  }
  build({ log: (m) => process.stdout.write(m + '\n'), toolVersion: require('../package.json').version })
    .then((r) => {
      process.stdout.write('wrote ' + Object.keys(r.manifest.sha256).length + ' shards to ' + r.outDir + '\n');
      process.stdout.write(JSON.stringify(r.stats) + '\n');
    })
    .catch((err) => {
      process.stderr.write('build failed: ' + (err && err.message ? err.message : String(err)) + '\n');
      process.exit(1);
    });
}

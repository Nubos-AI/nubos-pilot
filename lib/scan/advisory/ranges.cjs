'use strict';

const { NubosPilotError } = require('../../core.cjs');

const SUPPORTED = Object.freeze([
  'npm', 'PyPI', 'Go', 'crates.io', 'Maven', 'Packagist', 'RubyGems', 'NuGet',
]);

const UNBOUNDED_INTRODUCED = '0';

function _sign(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function _isDigits(value) {
  return /^\d+$/.test(value);
}

function _cmpDigits(a, b) {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return _sign(x, y);
}

function _cmpNumericSegments(a, b) {
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const result = _cmpDigits(i < a.length ? a[i] : '0', i < b.length ? b[i] : '0');
    if (result !== 0) return result;
  }
  return 0;
}

const _SEMVER_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function _semverParser(foldCase) {
  return (raw) => {
    const match = _SEMVER_RE.exec(raw);
    if (!match) return null;
    let prerelease = null;
    if (match[2] !== undefined) {
      prerelease = match[2].split('.');
      if (prerelease.some((id) => id === '')) return null;
      if (foldCase) prerelease = prerelease.map((id) => id.toLowerCase());
    }
    return { release: match[1].split('.'), prerelease };
  };
}

function _compareSemver(left, right) {
  const release = _cmpNumericSegments(left.release, right.release);
  if (release !== 0) return release;
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const width = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < width; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = _isDigits(a);
    const bNumeric = _isDigits(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    const result = aNumeric ? _cmpDigits(a, b) : _sign(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

const _PEP440_RE = new RegExp([
  '^v?(?:(\\d+)!)?',
  '(\\d+(?:\\.\\d+)*)',
  '(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\\d+)?)?',
  '(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?',
  '(?:[-_.]?(dev)[-_.]?(\\d+)?)?',
  '(?:\\+([0-9a-z]+(?:[-_.][0-9a-z]+)*))?$',
].join(''));

const _PEP440_PRE_ALIAS = Object.freeze({
  alpha: 0, a: 0, beta: 1, b: 1, c: 2, pre: 2, preview: 2, rc: 2,
});

const _PEP440_PRE_ABSENT = 3;
const _PEP440_PRE_DEV_ONLY = -1;

function _parsePep440(raw) {
  const match = _PEP440_RE.exec(raw.toLowerCase());
  if (!match) return null;
  const pre = match[3] === undefined
    ? null
    : { rank: _PEP440_PRE_ALIAS[match[3]], number: match[4] === undefined ? '0' : match[4] };
  let post = null;
  if (match[5] !== undefined) post = match[5];
  else if (match[6] !== undefined) post = match[7] === undefined ? '0' : match[7];
  const dev = match[8] === undefined ? null : (match[9] === undefined ? '0' : match[9]);
  const local = match[10] === undefined ? null : match[10].split(/[-_.]/);
  return {
    epoch: match[1] === undefined ? '0' : match[1],
    release: match[2].split('.'),
    pre,
    post,
    dev,
    local,
  };
}

function _pep440PreKey(parsed) {
  if (!parsed.pre) {
    if (parsed.post === null && parsed.dev !== null) return { rank: _PEP440_PRE_DEV_ONLY, number: '0' };
    return { rank: _PEP440_PRE_ABSENT, number: '0' };
  }
  return parsed.pre;
}

function _comparePep440Local(left, right) {
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = _isDigits(a);
    const bNumeric = _isDigits(b);
    if (aNumeric !== bNumeric) return aNumeric ? 1 : -1;
    const result = aNumeric ? _cmpDigits(a, b) : _sign(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

function _comparePep440(left, right) {
  const epoch = _cmpDigits(left.epoch, right.epoch);
  if (epoch !== 0) return epoch;

  const release = _cmpNumericSegments(left.release, right.release);
  if (release !== 0) return release;

  const leftPre = _pep440PreKey(left);
  const rightPre = _pep440PreKey(right);
  const preRank = _sign(leftPre.rank, rightPre.rank);
  if (preRank !== 0) return preRank;
  const preNumber = _cmpDigits(leftPre.number, rightPre.number);
  if (preNumber !== 0) return preNumber;

  if ((left.post === null) !== (right.post === null)) return left.post === null ? -1 : 1;
  if (left.post !== null) {
    const post = _cmpDigits(left.post, right.post);
    if (post !== 0) return post;
  }

  if ((left.dev === null) !== (right.dev === null)) return left.dev === null ? 1 : -1;
  if (left.dev !== null) {
    const dev = _cmpDigits(left.dev, right.dev);
    if (dev !== 0) return dev;
  }

  if (!left.local && !right.local) return 0;
  if (!left.local) return -1;
  if (!right.local) return 1;
  return _comparePep440Local(left.local, right.local);
}

const _COMPOSER_RE = /^(\d+(?:\.\d+){0,3})(?:[-_.]?([a-z0-9][a-z0-9.\-_]*))?$/;

const _COMPOSER_STABLE_RANK = 4;

const _COMPOSER_FORMS = Object.freeze([
  ['dev', 0], ['alpha', 1], ['a', 1], ['beta', 2], ['b', 2],
  ['rc', 3], ['#', 4], ['pl', 5], ['p', 5],
]);

function _composerRank(token) {
  for (const [name, rank] of _COMPOSER_FORMS) {
    if (token.startsWith(name)) return rank;
  }
  return -1;
}

function _composerTokens(tail) {
  return tail
    .replace(/[-_]/g, '.')
    .replace(/(\d)([a-z])/g, '$1.$2')
    .replace(/([a-z])(\d)/g, '$1.$2')
    .split('.')
    .filter((token) => token !== '');
}

function _parseComposer(raw) {
  let text = raw.toLowerCase();
  if (text.startsWith('v')) text = text.slice(1);
  const plus = text.indexOf('+');
  if (plus >= 0) text = text.slice(0, plus);
  const match = _COMPOSER_RE.exec(text);
  if (!match) return null;
  const release = match[1].split('.');
  while (release.length < 4) release.push('0');
  const tail = match[2] === undefined ? [] : _composerTokens(match[2]);
  return { release, tail: tail[0] === 'stable' ? [] : tail };
}

function _composerTokenRank(token) {
  return _isDigits(token) ? _COMPOSER_STABLE_RANK : _composerRank(token);
}

function _compareComposer(left, right) {
  const release = _cmpNumericSegments(left.release, right.release);
  if (release !== 0) return release;

  const shared = Math.min(left.tail.length, right.tail.length);
  for (let i = 0; i < shared; i += 1) {
    const a = left.tail[i];
    const b = right.tail[i];
    const bothNumeric = _isDigits(a) && _isDigits(b);
    const result = bothNumeric
      ? _cmpDigits(a, b)
      : _sign(_composerTokenRank(a), _composerTokenRank(b));
    if (result !== 0) return result;
  }

  if (left.tail.length === right.tail.length) return 0;
  const leftIsLonger = left.tail.length > right.tail.length;
  const extra = (leftIsLonger ? left : right).tail[shared];
  const direction = leftIsLonger ? 1 : -1;
  if (_isDigits(extra)) return direction;
  const extraRank = _sign(_composerRank(extra), _COMPOSER_STABLE_RANK);
  return extraRank === 0 ? 0 : direction * extraRank;
}

const _MAVEN_QUALIFIERS = Object.freeze(['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp']);
const _MAVEN_RELEASE_INDEX = String(_MAVEN_QUALIFIERS.indexOf(''));
const _MAVEN_ALIASES = Object.freeze({ ga: '', final: '', release: '', cr: 'rc' });
const _MAVEN_RE = /^[0-9a-z][0-9a-z._+-]*$/;

function _mavenQualifier(value) {
  const index = _MAVEN_QUALIFIERS.indexOf(value);
  return index === -1 ? _MAVEN_QUALIFIERS.length + '-' + value : String(index);
}

function _mavenInt(text) {
  return { kind: 'int', value: text };
}

function _mavenList() {
  return { kind: 'list', value: [] };
}

function _mavenString(text, followedByDigit) {
  let value = text;
  if (followedByDigit && value.length === 1) {
    if (value === 'a') value = 'alpha';
    else if (value === 'b') value = 'beta';
    else if (value === 'm') value = 'milestone';
  }
  if (Object.prototype.hasOwnProperty.call(_MAVEN_ALIASES, value)) value = _MAVEN_ALIASES[value];
  return { kind: 'string', value };
}

function _mavenItem(isDigit, text) {
  return isDigit ? _mavenInt(text) : _mavenString(text, false);
}

function _mavenIsNull(item) {
  if (item.kind === 'int') return _cmpDigits(item.value, '0') === 0;
  if (item.kind === 'string') return _mavenQualifier(item.value) === _MAVEN_RELEASE_INDEX;
  return item.value.length === 0;
}

function _compareMavenItem(left, right) {
  if (left === null) {
    if (right === null) return 0;
    const mirrored = _compareMavenItem(right, null);
    return mirrored === 0 ? 0 : -mirrored;
  }
  if (right === null) {
    if (left.kind === 'int') return _cmpDigits(left.value, '0') === 0 ? 0 : 1;
    if (left.kind === 'string') return _sign(_mavenQualifier(left.value), _MAVEN_RELEASE_INDEX);
    for (const item of left.value) {
      const result = _compareMavenItem(item, null);
      if (result !== 0) return result;
    }
    return 0;
  }
  if (left.kind === 'int') {
    return right.kind === 'int' ? _cmpDigits(left.value, right.value) : 1;
  }
  if (left.kind === 'string') {
    if (right.kind === 'int') return -1;
    if (right.kind === 'string') return _sign(_mavenQualifier(left.value), _mavenQualifier(right.value));
    return -1;
  }
  if (right.kind === 'int') return -1;
  if (right.kind === 'string') return 1;
  const width = Math.max(left.value.length, right.value.length);
  for (let i = 0; i < width; i += 1) {
    const a = i < left.value.length ? left.value[i] : null;
    const b = i < right.value.length ? right.value[i] : null;
    const result = _compareMavenItem(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

function _mavenNormalize(list) {
  for (let i = list.value.length - 1; i >= 0; i -= 1) {
    const item = list.value[i];
    if (_mavenIsNull(item)) list.value.splice(i, 1);
    else if (item.kind !== 'list') break;
  }
}

function _parseMaven(raw) {
  const text = raw.toLowerCase();
  if (!_MAVEN_RE.test(text) || !/\d/.test(text)) return null;
  const root = _mavenList();
  const stack = [root];
  let list = root;
  let isDigit = false;
  let start = 0;

  const descend = () => {
    const next = _mavenList();
    list.value.push(next);
    list = next;
    stack.push(next);
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '.' || char === '-') {
      if (i === start) list.value.push(_mavenInt('0'));
      else list.value.push(_mavenItem(isDigit, text.slice(start, i)));
      start = i + 1;
      if (char === '-') descend();
    } else if (char >= '0' && char <= '9') {
      if (!isDigit && i > start) {
        if (list.value.length > 0) descend();
        list.value.push(_mavenString(text.slice(start, i), true));
        start = i;
        descend();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.value.push(_mavenItem(true, text.slice(start, i)));
        start = i;
        descend();
      }
      isDigit = false;
    }
  }
  if (text.length > start) {
    if (!isDigit && list.value.length > 0) descend();
    list.value.push(_mavenItem(isDigit, text.slice(start)));
  }
  while (stack.length > 0) _mavenNormalize(stack.pop());
  return root;
}

const _GEM_RE = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function _gemTrimTrailingZeros(segments) {
  let end = segments.length;
  while (end > 0) {
    const last = segments[end - 1];
    if (last.number !== undefined && _cmpDigits(last.number, '0') === 0) end -= 1;
    else break;
  }
  return segments.slice(0, end);
}

function _parseGem(raw) {
  if (!_GEM_RE.test(raw)) return null;
  const tokens = raw.replace('-', '.pre.').match(/[0-9]+|[a-zA-Z]+/g) || [];
  const segments = tokens.map((token) => (
    _isDigits(token) ? { number: token } : { text: token }
  ));
  let firstText = segments.findIndex((segment) => segment.text !== undefined);
  if (firstText === -1) firstText = segments.length;
  return _gemTrimTrailingZeros(segments.slice(0, firstText))
    .concat(_gemTrimTrailingZeros(segments.slice(firstText)));
}

function _compareGem(left, right) {
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i += 1) {
    const a = i < left.length ? left[i] : { number: '0' };
    const b = i < right.length ? right[i] : { number: '0' };
    if (a.text !== undefined && b.number !== undefined) return -1;
    if (a.number !== undefined && b.text !== undefined) return 1;
    const result = a.number !== undefined
      ? _cmpDigits(a.number, b.number)
      : _sign(a.text, b.text);
    if (result !== 0) return result;
  }
  return 0;
}

const _ENGINES = Object.freeze({
  npm: { parse: _semverParser(false), compare: _compareSemver },
  'crates.io': { parse: _semverParser(false), compare: _compareSemver },
  Go: { parse: _semverParser(false), compare: _compareSemver },
  NuGet: { parse: _semverParser(true), compare: _compareSemver },
  PyPI: { parse: _parsePep440, compare: _comparePep440 },
  Packagist: { parse: _parseComposer, compare: _compareComposer },
  Maven: { parse: _parseMaven, compare: _compareMavenItem },
  RubyGems: { parse: _parseGem, compare: _compareGem },
});

function isSupported(ecosystem) {
  return typeof ecosystem === 'string' && SUPPORTED.includes(ecosystem);
}

function _engine(ecosystem) {
  if (!isSupported(ecosystem)) {
    throw new NubosPilotError(
      'ranges-unsupported-ecosystem',
      'no version comparator for ecosystem ' + JSON.stringify(ecosystem),
      { ecosystem, supported: SUPPORTED },
    );
  }
  return _ENGINES[ecosystem];
}

function _text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function _tryParse(engine, value) {
  const text = _text(value);
  if (text === null || text === '') return null;
  return engine.parse(text);
}

function _mustParse(ecosystem, engine, value, role) {
  const parsed = _tryParse(engine, value);
  if (parsed === null) {
    throw new NubosPilotError(
      'ranges-unparseable-version',
      'cannot parse ' + ecosystem + ' version ' + JSON.stringify(value),
      { ecosystem, version: value, role },
    );
  }
  return parsed;
}

function compare(ecosystem, a, b) {
  const engine = _engine(ecosystem);
  const left = _mustParse(ecosystem, engine, a, 'operand');
  const right = _mustParse(ecosystem, engine, b, 'operand');
  return engine.compare(left, right);
}

function _eventBoundary(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  for (const kind of ['introduced', 'fixed', 'last_affected']) {
    if (!Object.prototype.hasOwnProperty.call(event, kind)) continue;
    const value = _text(event[kind]);
    if (value === null || value === '') continue;
    return { kind, value };
  }
  return null;
}

function _intervals(range) {
  const events = range && typeof range === 'object' && Array.isArray(range.events) ? range.events : [];
  const intervals = [];
  let open = null;
  for (const event of events) {
    const boundary = _eventBoundary(event);
    if (!boundary) continue;
    if (boundary.kind === 'introduced') {
      if (open) intervals.push(open);
      open = { introduced: boundary.value, fixed: null, lastAffected: null };
      continue;
    }
    if (!open) open = { introduced: UNBOUNDED_INTRODUCED, fixed: null, lastAffected: null };
    if (boundary.kind === 'fixed') open.fixed = boundary.value;
    else open.lastAffected = boundary.value;
    intervals.push(open);
    open = null;
  }
  if (open) intervals.push(open);
  return intervals;
}

function _contains(ecosystem, engine, target, interval) {
  if (interval.introduced !== UNBOUNDED_INTRODUCED) {
    const lower = _mustParse(ecosystem, engine, interval.introduced, 'introduced');
    if (engine.compare(target, lower) < 0) return false;
  }
  if (interval.fixed !== null) {
    const upper = _mustParse(ecosystem, engine, interval.fixed, 'fixed');
    if (engine.compare(target, upper) >= 0) return false;
  } else if (interval.lastAffected !== null) {
    const upper = _mustParse(ecosystem, engine, interval.lastAffected, 'last_affected');
    if (engine.compare(target, upper) > 0) return false;
  }
  return true;
}

function _rangeList(ranges) {
  return Array.isArray(ranges) ? ranges : [];
}

function inRange(ecosystem, version, ranges) {
  const engine = _engine(ecosystem);
  const target = _tryParse(engine, version);
  if (target === null) return false;
  for (const range of _rangeList(ranges)) {
    for (const interval of _intervals(range)) {
      if (_contains(ecosystem, engine, target, interval)) return true;
    }
  }
  return false;
}

function firstFixed(ecosystem, version, ranges) {
  const engine = _engine(ecosystem);
  const target = _tryParse(engine, version);
  if (target === null) return null;
  let affected = false;
  let best = null;
  for (const range of _rangeList(ranges)) {
    for (const interval of _intervals(range)) {
      if (!_contains(ecosystem, engine, target, interval)) continue;
      affected = true;
      if (interval.fixed === null) return null;
      const parsed = _mustParse(ecosystem, engine, interval.fixed, 'fixed');
      if (best === null || engine.compare(parsed, best.parsed) > 0) {
        best = { raw: interval.fixed, parsed };
      }
    }
  }
  return affected && best !== null ? best.raw : null;
}

module.exports = { SUPPORTED, compare, isSupported, inRange, firstFixed };

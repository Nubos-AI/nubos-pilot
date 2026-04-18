const { NubosPilotError } = require('../core.cjs');

function detectLineEnding(content) {
  if (typeof content !== 'string') {
    throw new NubosPilotError(
      'codex-toml-invalid-input',
      'detectLineEnding expects a string',
      { got: typeof content },
    );
  }
  const firstNewlineIndex = content.indexOf('\n');
  if (firstNewlineIndex === -1) return '\n';
  return firstNewlineIndex > 0 && content[firstNewlineIndex - 1] === '\r' ? '\r\n' : '\n';
}

function splitTomlLines(content) {
  const lines = [];
  let start = 0;
  while (start < content.length) {
    const newlineIndex = content.indexOf('\n', start);
    if (newlineIndex === -1) {
      lines.push({
        start,
        end: content.length,
        text: content.slice(start),
        eol: '',
      });
      break;
    }
    const hasCr = newlineIndex > start && content[newlineIndex - 1] === '\r';
    const end = hasCr ? newlineIndex - 1 : newlineIndex;
    lines.push({
      start,
      end,
      text: content.slice(start, end),
      eol: hasCr ? '\r\n' : '\n',
    });
    start = newlineIndex + 1;
  }
  return lines;
}

function isEscapedInBasicString(line, index) {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && line[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
}

function findMultilineBasicStringClose(line, startIndex) {
  let searchIndex = startIndex;
  while (searchIndex < line.length) {
    const closeIndex = line.indexOf('"""', searchIndex);
    if (closeIndex === -1) return -1;
    if (!isEscapedInBasicString(line, closeIndex)) return closeIndex;
    searchIndex = closeIndex + 1;
  }
  return -1;
}

function findTomlCommentStart(line) {
  let i = 0;
  let multilineState = null;
  while (i < line.length) {
    if (multilineState === 'literal') {
      const closeIndex = line.indexOf("'''", i);
      if (closeIndex === -1) return -1;
      i = closeIndex + 3;
      multilineState = null;
      continue;
    }
    if (multilineState === 'basic') {
      const closeIndex = findMultilineBasicStringClose(line, i);
      if (closeIndex === -1) return -1;
      i = closeIndex + 3;
      multilineState = null;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return i;
    if (ch === "'") {
      if (line.startsWith("'''", i)) {
        multilineState = 'literal';
        i += 3;
        continue;
      }
      const close = line.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      if (line.startsWith('"""', i)) {
        multilineState = 'basic';
        i += 3;
        continue;
      }
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

function advanceTomlMultilineStringState(line, multilineState) {
  let i = 0;
  let state = multilineState;
  while (i < line.length) {
    if (state === 'literal') {
      const closeIndex = line.indexOf("'''", i);
      if (closeIndex === -1) return state;
      i = closeIndex + 3;
      state = null;
      continue;
    }
    if (state === 'basic') {
      const closeIndex = findMultilineBasicStringClose(line, i);
      if (closeIndex === -1) return state;
      i = closeIndex + 3;
      state = null;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return state;
    if (ch === "'") {
      if (line.startsWith("'''", i)) {
        state = 'literal';
        i += 3;
        continue;
      }
      const close = line.indexOf("'", i + 1);
      if (close === -1) return state;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      if (line.startsWith('"""', i)) {
        state = 'basic';
        i += 3;
        continue;
      }
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return state;
}

function findTomlAssignmentEquals(line) {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') return -1;
    if (ch === "'") {
      i += 1;
      while (i < line.length) {
        if (line[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '=') return i;
    i += 1;
  }
  return -1;
}

function parseTomlKeyPath(keyText) {
  const segments = [];
  let i = 0;
  while (i < keyText.length) {
    while (i < keyText.length && /\s/.test(keyText[i])) i += 1;
    if (i >= keyText.length) break;
    if (keyText[i] === "'" || keyText[i] === '"') {
      const quote = keyText[i];
      let segment = '';
      let closed = false;
      i += 1;
      while (i < keyText.length) {
        if (quote === '"' && keyText[i] === '\\') {
          if (i + 1 >= keyText.length) return null;
          segment += keyText[i + 1];
          i += 2;
          continue;
        }
        if (keyText[i] === quote) { i += 1; closed = true; break; }
        segment += keyText[i];
        i += 1;
      }
      if (!closed) return null;
      segments.push(segment);
    } else {
      const match = keyText.slice(i).match(/^[A-Za-z0-9_-]+/);
      if (!match) return null;
      segments.push(match[0]);
      i += match[0].length;
    }
    while (i < keyText.length && /\s/.test(keyText[i])) i += 1;
    if (i >= keyText.length) break;
    if (keyText[i] !== '.') return null;
    i += 1;
  }
  return segments.length > 0 ? segments : null;
}

function parseTomlBracketHeader(line, array) {
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  const open = array ? '[[' : '[';
  const close = array ? ']]' : ']';
  if (!line.startsWith(open, i)) return null;
  i += open.length;
  const start = i;
  while (i < line.length) {
    if (line[i] === "'" || line[i] === '"') {
      const quote = line[i];
      i += 1;
      while (i < line.length) {
        if (quote === '"' && line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (line.startsWith(close, i)) {
      const rawPath = line.slice(start, i).trim();
      const segments = parseTomlKeyPath(rawPath);
      if (!segments) return null;
      i += close.length;
      while (i < line.length && /\s/.test(line[i])) i += 1;
      if (i < line.length && line[i] !== '#') return null;
      return { path: segments.join('.'), segments, array };
    }
    if (line[i] === '#' || line[i] === '\r' || line[i] === '\n') return null;
    i += 1;
  }
  return null;
}

function parseTomlTableHeader(line) {
  return parseTomlBracketHeader(line, true) || parseTomlBracketHeader(line, false);
}

function parseTomlKey(line) {
  const header = parseTomlTableHeader(line);
  if (header) return null;
  const equalsIndex = findTomlAssignmentEquals(line);
  if (equalsIndex === -1) return null;
  const raw = line.slice(0, equalsIndex).trim();
  const segments = parseTomlKeyPath(raw);
  if (!segments) return null;
  return { raw, segments };
}

function getTomlLineRecords(content) {
  const lines = splitTomlLines(content);
  const records = [];
  let currentTablePath = null;
  let multilineState = null;
  for (const line of lines) {
    const startsInMultilineString = multilineState !== null;
    const record = {
      ...line,
      startsInMultilineString,
      tablePath: currentTablePath,
      tableHeader: null,
      keySegments: null,
      keyRaw: null,
    };
    if (!startsInMultilineString) {
      const header = parseTomlTableHeader(line.text);
      if (header) {
        record.tableHeader = header;
        currentTablePath = header.path;
      } else {
        const key = parseTomlKey(line.text);
        record.keySegments = key ? key.segments : null;
        record.keyRaw = key ? key.raw : null;
      }
    }
    multilineState = advanceTomlMultilineStringState(line.text, multilineState);
    records.push(record);
  }
  return records;
}

function getTomlTableSections(content) {
  const headerLines = getTomlLineRecords(content).filter((record) => record.tableHeader);
  return headerLines.map((record, index) => ({
    path: record.tableHeader.path,
    array: record.tableHeader.array,
    start: record.start,
    headerEnd: record.end + record.eol.length,
    end: index + 1 < headerLines.length ? headerLines[index + 1].start : content.length,
  }));
}

function collapseTomlBlankLines(content) {
  const eol = detectLineEnding(content);
  return content.replace(/(?:\r?\n){3,}/g, eol + eol);
}

function removeContentRanges(content, ranges) {
  const normalizedRanges = ranges
    .filter((range) => range && range.start < range.end)
    .sort((a, b) => a.start - b.start);
  if (normalizedRanges.length === 0) return content;
  const mergedRanges = [{ ...normalizedRanges[0] }];
  for (let i = 1; i < normalizedRanges.length; i += 1) {
    const current = normalizedRanges[i];
    const previous = mergedRanges[mergedRanges.length - 1];
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }
    mergedRanges.push({ ...current });
  }
  let cleaned = '';
  let cursor = 0;
  for (const range of mergedRanges) {
    cleaned += content.slice(cursor, range.start);
    cursor = range.end;
  }
  cleaned += content.slice(cursor);
  return cleaned;
}

function _isTrappedRecord(record, featuresSection) {
  if (record.tableHeader || record.startsInMultilineString) return false;
  if (record.tablePath !== 'features') return false;
  if (record.start < featuresSection.headerEnd) return false;
  if (record.end + record.eol.length > featuresSection.end) return false;
  if (!record.keySegments || record.keySegments.length === 0) return false;
  const equalsIndex = findTomlAssignmentEquals(record.text);
  if (equalsIndex === -1) return false;
  const commentStart = findTomlCommentStart(record.text);
  const valueText = record.text
    .slice(equalsIndex + 1, commentStart === -1 ? record.text.length : commentStart)
    .trim();
  if (valueText === 'true' || valueText === 'false') return false;

  if (valueText.startsWith("'''") || valueText.startsWith('"""')) return false;
  return true;
}

function hasTrappedFeatures(content) {
  if (typeof content !== 'string') {
    throw new NubosPilotError(
      'codex-toml-invalid-input',
      'hasTrappedFeatures expects a string',
      { got: typeof content },
    );
  }
  const featuresSection = getTomlTableSections(content)
    .find((section) => !section.array && section.path === 'features');
  if (!featuresSection) return false;
  const records = getTomlLineRecords(content);
  for (const record of records) {
    if (_isTrappedRecord(record, featuresSection)) return true;
  }
  return false;
}

function repairTrappedFeatures(content) {
  if (typeof content !== 'string') {
    throw new NubosPilotError(
      'codex-toml-invalid-input',
      'repairTrappedFeatures expects a string',
      { got: typeof content },
    );
  }
  const eol = detectLineEnding(content);
  const featuresSection = getTomlTableSections(content)
    .find((section) => !section.array && section.path === 'features');
  if (!featuresSection) return content;

  const lineRecords = getTomlLineRecords(content);
  const trappedLines = lineRecords.filter((r) => _isTrappedRecord(r, featuresSection));
  if (trappedLines.length === 0) return content;

  
  const relocatedText = trappedLines.map((r) => r.text).join(eol) + eol;

  const removalRanges = trappedLines.map((r) => ({
    start: r.start,
    end: r.end + r.eol.length,
  }));
  let cleaned = removeContentRanges(content, removalRanges);
  cleaned = collapseTomlBlankLines(cleaned);

  const cleanedRecords = getTomlLineRecords(cleaned);
  const cleanedFeaturesHeader = cleanedRecords.find(
    (r) => r.tableHeader && r.tableHeader.path === 'features' && !r.tableHeader.array,
  );
  if (!cleanedFeaturesHeader) return cleaned;

  const before = cleaned.slice(0, cleanedFeaturesHeader.start);
  const after = cleaned.slice(cleanedFeaturesHeader.start);
  const needsGap = before.length > 0 && !before.endsWith(eol + eol);
  const trailingGap = after.length > 0 && !relocatedText.endsWith(eol + eol) ? eol : '';
  return before + (needsGap ? eol : '') + relocatedText + trailingGap + after;
}

module.exports = {
  hasTrappedFeatures,
  repairTrappedFeatures,
  detectLineEnding,

  
  getTomlLineRecords,
  getTomlTableSections,
  findTomlCommentStart,
  findTomlAssignmentEquals,
  removeContentRanges,
  collapseTomlBlankLines,
};

const { NubosPilotError } = require('./core.cjs');

function _parseError(line, snippet, msg) {
  return new NubosPilotError(
    'frontmatter-parse-error',
    msg,
    { line, snippet },
  );
}

function splitInlineArray(body, lineNo, rawLine) {
  const items = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ',') {
      const trimmed = current.trim();
      if (trimmed) items.push(_coerceScalar(trimmed));
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    throw _parseError(lineNo, rawLine, `Unclosed ${inQuote === '"' ? 'double' : 'single'} quote in inline array`);
  }
  const trimmed = current.trim();
  if (trimmed) items.push(_coerceScalar(trimmed));
  return items;
}

function _stripQuotes(v) {
  if (v.length >= 2) {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return { stripped: v.slice(1, -1), quoted: true };
    }
  }
  return { stripped: v, quoted: false };
}

function _coerceScalar(raw) {
  const { stripped, quoted } = _stripQuotes(raw);
  if (quoted) return stripped;
  if (stripped === '' || stripped === '~' || stripped === 'null') return null;
  if (stripped === 'true') return true;
  if (stripped === 'false') return false;
  if (/^-?\d+$/.test(stripped)) {

    if (/^-?0\d/.test(stripped)) return stripped;
    return Number(stripped);
  }
  if (/^-?\d+\.\d+$/.test(stripped)) return Number(stripped);
  return stripped;
}

function _validateScalarQuoting(value, lineNo, rawLine) {
  const trimmed = value.trim();
  if (trimmed === '') return;
  if (trimmed.startsWith('"')) {

    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw _parseError(lineNo, rawLine, 'Unclosed double-quoted string');
    }
  } else if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      throw _parseError(lineNo, rawLine, 'Unclosed single-quoted string');
    }
  }
}

function extractFrontmatter(content) {
  if (typeof content !== 'string') {
    throw _parseError(0, '', 'extractFrontmatter: input must be a string');
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yaml = match[1];
  const body = match[2];
  const lines = yaml.split(/\r?\n/);

  const frontmatter = {};

  
  const stack = [{ container: frontmatter, indent: -1, pendingKey: null }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === '') continue;

    const leading = line.match(/^[ \t]*/)[0];
    if (leading.includes('\t')) {
      throw _parseError(lineNo, line, 'Tab indentation is not allowed; use spaces');
    }
    const indent = leading.length;

    
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      const popped = stack.pop();
      _demoteEmptyPlaceholder(popped, stack);
    }
    const current = stack[stack.length - 1];

    const trimmed = line.trim();

    if (trimmed.startsWith('- ') || trimmed === '-') {
      const itemBody = trimmed === '-' ? '' : trimmed.slice(2);

      
      if (current.pendingKey !== null) {

        
        const parent = stack[stack.length - 2];
        if (parent) {
          parent.container[current.pendingKey] = [];
          current.container = parent.container[current.pendingKey];
          current.pendingKey = null;
        }
      }

      if (!Array.isArray(current.container)) {
        throw _parseError(lineNo, line, 'Unexpected "- " outside of a list context');
      }

      if (itemBody.includes(':') && /^[a-zA-Z0-9_-]+\s*:/.test(itemBody)) {
        const kv = itemBody.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (!kv) {
          throw _parseError(lineNo, line, 'Malformed inline mapping in list item');
        }
        const itemObj = {};
        _assignKeyValue(itemObj, kv[1], kv[2], lineNo, line);
        current.container.push(itemObj);

        

        stack.push({ container: itemObj, indent: indent + 1, pendingKey: null });
      } else {

        _validateScalarQuoting(itemBody, lineNo, line);
        current.container.push(_coerceScalar(itemBody));
      }
      continue;
    }

    const kvMatch = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      throw _parseError(lineNo, line, 'Line does not match "key: value" or "- item" pattern');
    }
    const key = kvMatch[1];
    const value = kvMatch[2];

    if (Array.isArray(current.container)) {

      

      throw _parseError(lineNo, line, 'Unexpected key inside array context');
    }

    _assignKeyValue(current.container, key, value, lineNo, line, stack, indent);
  }

  

  for (const entry of stack) {
    if (entry.pendingKey !== null) {
      const parent = _findParentOfContainer(frontmatter, entry.container);
      if (parent && parent.obj && parent.key === entry.pendingKey) {
        if (typeof entry.container === 'object' && !Array.isArray(entry.container) && Object.keys(entry.container).length === 0) {
          parent.obj[entry.pendingKey] = null;
        }
      }
    }
  }

  return { frontmatter, body };
}

function _demoteEmptyPlaceholder(poppedEntry, remainingStack) {
  if (poppedEntry.pendingKey === null) return;
  const c = poppedEntry.container;
  if (typeof c !== 'object' || c === null) return;
  if (Array.isArray(c)) return;
  if (Object.keys(c).length !== 0) return;

  const parent = remainingStack[remainingStack.length - 1];
  if (parent && parent.container && !Array.isArray(parent.container)) {
    if (parent.container[poppedEntry.pendingKey] === c) {
      parent.container[poppedEntry.pendingKey] = null;
    }
  }
}

function _findParentOfContainer(root, target, path = []) {
  if (root === target) return null; 
  if (typeof root !== 'object' || root === null) return null;
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      if (root[i] === target) return { obj: root, key: i };
      const nested = _findParentOfContainer(root[i], target, path.concat(i));
      if (nested) return nested;
    }
    return null;
  }
  for (const k of Object.keys(root)) {
    if (root[k] === target) return { obj: root, key: k };
    const nested = _findParentOfContainer(root[k], target, path.concat(k));
    if (nested) return nested;
  }
  return null;
}

function _assignKeyValue(obj, key, rawValue, lineNo, line, stack, indent) {
  const value = rawValue;
  const trimmedValue = value.trim();

  if (trimmedValue === '') {

    

    
    obj[key] = {};
    if (stack) {
      stack.push({ container: obj[key], indent, pendingKey: key });
    }
    return;
  }

  if (trimmedValue.startsWith('[') && trimmedValue.endsWith(']')) {
    const inner = trimmedValue.slice(1, -1);
    obj[key] = splitInlineArray(inner, lineNo, line);
    return;
  }

  _validateScalarQuoting(trimmedValue, lineNo, line);
  obj[key] = _coerceScalar(trimmedValue);
}

module.exports = { extractFrontmatter };

'use strict';

// CL-D26. CONTRACT.md is the authoritative record of the decisions this package
// implements, and test/contract-clauses.json is how those decisions are enforced
// against the shipped prose. The two must stay in step.
//
// The linkage is deliberately per clause rather than per marker. A marker is a
// required landmark in an implementation file; it is not ownership metadata for
// this record.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, exists } = require('./helpers');

const RECORD = 'CONTRACT.md';
const STRUCTURAL_VALUE = 'none — structural';

function normalizeLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
const STRUCTURAL_DECISIONS = new Set([
  'CL-D19',
  'CL-D21',
  'CL-D26',
  'DEC-EXT-SNAPSHOT-001',
  'DEC-I22-PROMPT-AUTHORITY-001',
]);
const CODE_MASK = '\u0000';
const AC_DECISION_FIELDS = [
  'Decision ID',
  'Kind',
  'Target and revision',
  'Question',
  'Options and trade-offs',
  'Recommendation',
  'Owner choice',
  'Rationale',
  'Validity and invalidation conditions',
];

// JSON.parse accepts duplicate object keys by keeping only the last value. The
// manifest is contract input, so scan its raw syntax first and reject duplicate
// keys before parsing can hide an undocumented mutation.
function assertUniqueJsonKeys(source) {
  assert.equal(typeof source, 'string', 'manifest source must be text');
  let index = 0;

  const fail = (message) => assert.fail(`invalid manifest JSON: ${message} at byte ${index}`);
  const whitespace = () => {
    while (/\s/.test(source[index] || '')) index += 1;
  };
  const string = () => {
    if (source[index] !== '"') fail('expected string');
    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') return JSON.parse(source.slice(start, index));
      if (char === '\\') {
        if (index >= source.length) fail('unterminated escape');
        index += 1;
      } else if (char < ' ') {
        fail('unescaped control character');
      }
    }
    fail('unterminated string');
  };
  const value = () => {
    whitespace();
    if (source[index] === '{') return object();
    if (source[index] === '[') return array();
    if (source[index] === '"') return string();
    const start = index;
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
    const token = source.slice(start, index);
    if (!token || !['true', 'false', 'null'].includes(token)) {
      try {
        JSON.parse(token);
      } catch {
        fail(`invalid value ${JSON.stringify(token)}`);
      }
    }
    return token;
  };
  const array = () => {
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return;
    }
    while (true) {
      value();
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      if (source[index++] !== ',') fail('expected comma or closing array bracket');
    }
  };
  const object = () => {
    index += 1;
    const keys = new Set();
    whitespace();
    if (source[index] === '}') {
      index += 1;
      return;
    }
    while (true) {
      whitespace();
      const key = string();
      if (keys.has(key)) assert.fail(`duplicate JSON object key: ${key}`);
      keys.add(key);
      whitespace();
      if (source[index++] !== ':') fail('expected colon after object key');
      value();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      if (source[index++] !== ',') fail('expected comma or closing object brace');
    }
  };

  value();
  whitespace();
  assert.equal(index, source.length, 'manifest JSON has trailing data');
}

const manifestSource = readText('test/contract-clauses.json');
assertUniqueJsonKeys(manifestSource);
const manifest = JSON.parse(manifestSource);

// A null marker opts out of the in-file landmark for user-facing files such as
// README.md. It still owns the concrete clause ID in CONTRACT.md.
const decisionOf = (clause) =>
  'marker' in clause && clause.marker !== null ? clause.marker : clause.id;

function manifestClauseIds(value) {
  assert.ok(value && Array.isArray(value.clauses), 'manifest declares no clauses array');
  const ids = new Set();
  for (const clause of value.clauses) {
    assert.equal(typeof clause.id, 'string', 'every clause id must be a string');
    assert.ok(clause.id.trim(), 'every clause id must be non-empty');
    assert.equal(clause.id, clause.id.trim(), `clause id has surrounding whitespace: ${clause.id}`);
    assert.ok(!ids.has(clause.id), `duplicate clause id: ${clause.id}`);
    ids.add(clause.id);
    if ('marker' in clause && clause.marker !== null) {
      assert.equal(typeof clause.marker, 'string', `${clause.id} marker must be a string or null`);
      assert.ok(clause.marker.trim(), `${clause.id} marker must be non-empty when non-null`);
      assert.equal(clause.marker, clause.marker.trim(), `${clause.id} marker has surrounding whitespace`);
    }
  }
  return ids;
}

// Project Markdown block-code contexts without changing line offsets. The
// structural checks below intentionally operate on this projection rather than
// trying to become a general Markdown parser: fenced blocks and bounded
// indented-code lines are the only contexts that need to be invisible to the
// record inventory. `codeLines` is separate from the masked text because a
// zero-character blank code line cannot be recognized from its projection.
// `structuralSource` removes every code line while retaining non-code lines and
// their literal blank lines, so masked code never becomes an empty paragraph.
function projectMarkdownCodeContext(source) {
  const masked = source.split('');
  const lineStarts = [];
  const lineEnds = [];
  for (let start = 0; start <= source.length;) {
    const end = source.indexOf('\n', start);
    lineStarts.push(start);
    lineEnds.push(end === -1 ? source.length : end);
    if (end === -1) break;
    start = end + 1;
  }
  const codeLines = new Uint8Array(lineStarts.length);
  const maskLine = (lineIndex) => {
    codeLines[lineIndex] = 1;
    for (let index = lineStarts[lineIndex]; index < lineEnds[lineIndex]; index += 1) {
      // NUL is a non-structural sentinel that marks masked code while preserving
      // the original UTF-16 length and line boundaries.
      masked[index] = CODE_MASK;
    }
  };
  const fenceOpenerAt = (lineIndex) => {
    const start = lineStarts[lineIndex];
    const end = lineEnds[lineIndex];
    let index = start;
    let indent = 0;
    while (index < end && source[index] === ' ' && indent < 4) {
      index += 1;
      indent += 1;
    }
    if (indent > 3 || index >= end || (source[index] !== '`' && source[index] !== '~')) return null;
    const marker = source[index];
    const runStart = index;
    while (index < end && source[index] === marker) index += 1;
    if (index - runStart < 3) return null;
    // CommonMark does not allow a backtick in a backtick fence's info string.
    if (marker === '`' && source.slice(index, end).includes('`')) return null;
    return { marker, length: index - runStart };
  };
  const fenceCloserAt = (lineIndex, opener) => {
    const start = lineStarts[lineIndex];
    const end = lineEnds[lineIndex];
    let index = start;
    let indent = 0;
    while (index < end && source[index] === ' ' && indent < 4) {
      index += 1;
      indent += 1;
    }
    if (indent > 3 || index >= end || source[index] !== opener.marker) return false;
    const runStart = index;
    while (index < end && source[index] === opener.marker) index += 1;
    if (index - runStart < opener.length) return false;
    for (; index < end; index += 1) {
      if (source[index] !== ' ' && source[index] !== '\t') return false;
    }
    return true;
  };

  // Claim each line once. A four-space/tab line is deliberately bounded to its
  // own line; this prevents hiding 0-3-space structural records below it.
  // Whitespace-only lines between indented code lines belong to that block too.
  let lineIndex = 0;
  let inIndentedCode = false;
  const isBlankLine = (index) => {
    for (let character = lineStarts[index]; character < lineEnds[index]; character += 1) {
      if (source[character] !== ' ' && source[character] !== '\t') return false;
    }
    return true;
  };
  while (lineIndex < lineStarts.length) {
    const opener = fenceOpenerAt(lineIndex);
    if (opener) {
      inIndentedCode = false;
      maskLine(lineIndex);
      lineIndex += 1;
      while (lineIndex < lineStarts.length) {
        const closer = fenceCloserAt(lineIndex, opener);
        maskLine(lineIndex);
        lineIndex += 1;
        if (closer) break;
      }
      continue;
    }
    const start = lineStarts[lineIndex];
    const indented = source[start] === '\t' || source.startsWith('    ', start);
    if (indented) {
      maskLine(lineIndex);
      inIndentedCode = true;
    } else if (inIndentedCode && isBlankLine(lineIndex)) {
      maskLine(lineIndex);
    } else {
      inIndentedCode = false;
    }
    lineIndex += 1;
  }

  const maskedSource = masked.join('');
  const structuralLines = [];
  for (let index = 0; index < lineStarts.length; index += 1) {
    if (!codeLines[index]) structuralLines.push(maskedSource.slice(lineStarts[index], lineEnds[index]));
  }
  const structuralSource = structuralLines.join('\n');
  const lineIndexByStart = new Map(lineStarts.map((start, index) => [start, index]));
  return { masked: maskedSource, structuralSource, codeLines, lineStarts, lineEnds, lineIndexByStart };
}

function assertCanonicalRecordLines(normalized, projection = projectMarkdownCodeContext(normalized)) {
  const decisionLike = /(?:CL-D|AC-|DEC-)[A-Za-z0-9-]+/;
  const canonicalHeading = /^## [A-Z][A-Z0-9-]* — (?:\S(?:.*\S)?)$/;
  const canonicalMetadata = /^\*\*Clauses:\*\* \S(?:.*\S)?$/;
  const entityToken = '&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);';
  const entity = new RegExp(entityToken, 'i');
  const entityGlobal = new RegExp(entityToken, 'gi');
  const asciiPunctuation = new Set([...`!\"#$%&'()*+,-./:;<=>?@[\\]^_\u0060{|}~`]);
  const restoreEscapedPunctuation = (value) => value.replace(/\\(.)/g, (match, character) =>
    asciiPunctuation.has(character) ? character : match,
  );
  const ownershipPattern = /^\s*__([^_\n]*)__((?:[^\S\r\n]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);)+)(\S.*)$/i;
  const normalizeReserved = (value) => value.replace(/\s+/g, '').toLowerCase() === 'clauses:';
  const isReservedOwnership = (candidate) => {
    const match = candidate.match(ownershipPattern);
    if (!match) return false;
    const decodedBody = decodeEntities(match[1]);
    const strippedBody = match[1].replace(entityGlobal, '');
    return normalizeReserved(decodedBody) || normalizeReserved(strippedBody);
  };
  const decodeNumericReference = (full, digits, radix) => {
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isFinite(codePoint) || !Number.isInteger(codePoint) ||
      codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return full;
    }
    return String.fromCodePoint(codePoint);
  };
  const decodeEntities = (value) => value
    .replace(/&#(\d+);/g, (full, code) => decodeNumericReference(full, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (full, code) => decodeNumericReference(full, code, 16))
    .replace(/&colon;/gi, ':')
    .replace(/&(?:nbsp|ensp|emsp|thinsp|hairsp|numsp|puncsp|mediumspace|tab|newline|zerowidthspace|verythinspace|negativethinspace);/gi, (name) => ({
      nbsp: '\u00a0',
      ensp: '\u2002',
      emsp: '\u2003',
      thinsp: '\u2009',
      hairsp: '\u200a',
      numsp: '\u2007',
      puncsp: '\u2008',
      mediumspace: '\u205f',
      tab: '\t',
      newline: '\n',
      zerowidthspace: '',
      verythinspace: '',
      negativethinspace: '',
    })[name.slice(1, -1).toLowerCase()])
    .replace(/[\u200a-\u200d\ufeff]/g, '');
  const reservedDECField = (value) => AC_DECISION_FIELDS.some((field) =>
    new RegExp(`^[ ]{0,3}\\*${field.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\*\\s+\\S`).test(value),
  );
  const structuralVariants = (value) => {
    const restored = restoreEscapedPunctuation(value);
    const decoded = decodeEntities(value);
    return [...new Set([
      value,
      restored,
      decoded,
      decodeEntities(restored),
      restoreEscapedPunctuation(decoded),
    ])];
  };
  const isDecisionHeading = (value) => /^\s*##(?!#)/.test(value) && decisionLike.test(value);
  const isClausesMetadata = (value) => /^\s*\*\*Clauses:\*\*\s+\S/.test(value);
  const normalizedFieldLabel = (value) => value.replace(/\s+/g, '').toLowerCase();
  const isDECFieldLabel = (value) => AC_DECISION_FIELDS.some((field) =>
    normalizedFieldLabel(value) === `${normalizedFieldLabel(field)}:`,
  );
  const isTripleClausesOwnership = (value) =>
    /^\s*(?:\*\*\*|___)Clauses:(?:\*\*\*|___)\s+\S/.test(value);
  const escapedFieldLabels = AC_DECISION_FIELDS.map((field) =>
    field.replace(/[.*+?^${}()|[\]\\\\]/g, '\\\\$&'),
  );
  const isSingleDECFieldAlternative = (value) => new RegExp(
    `^\\s*_(?:${escapedFieldLabels.join('|')}):_\\s+\\S`,
  ).test(value);
  const targetTagNames = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i']);
  const isTagNameCharacter = (code) =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x3a;

  // Quote-aware monotonic tokenizer shared by the rendered scanner and inline
  // candidate normalization. Invalid `<...` input is consumed through either
  // its next nested unquoted `<` (which may restart a valid candidate) or EOF.
  const readHtmlTag = (source, start) => {
    if (source[start] !== '<') return { valid: false, restart: start + 1 };
    let index = start + 1;
    let closing = false;
    if (source[index] === '/') {
      closing = true;
      index += 1;
    }
    const nameStart = index;
    if (!/[A-Za-z]/.test(source[index] || '')) return { valid: false, restart: start + 1 };
    while (index < source.length && isTagNameCharacter(source.charCodeAt(index))) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    let quote = '';
    while (index < source.length) {
      const character = source[index++];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '<') {
        return { valid: false, restart: index - 1 };
      } else if (character === '>') {
        return { valid: true, end: index, name, closing };
      }
    }
    return { valid: false, restart: source.length };
  };
  const tokenizeHtml = (source, { onText, onTag }) => {
    let textStart = 0;
    let index = 0;
    const emitText = (end) => {
      if (end > textStart) onText(source.slice(textStart, end), textStart, end);
    };
    while (index < source.length) {
      if (source[index] !== '<') {
        index += 1;
        continue;
      }
      const token = readHtmlTag(source, index);
      if (!token.valid) {
        index = token.restart;
        continue;
      }
      emitText(index);
      onTag(token, index, token.end);
      index = token.end;
      textStart = index;
    }
    emitText(source.length);
  };
  const paragraphAt = (source) => {
    const result = new Int32Array(source.length + 1);
    let paragraph = 0;
    let whitespaceLine = true;
    for (let index = 0; index < source.length; index += 1) {
      result[index] = paragraph;
      if (source[index] === '\n') {
        if (whitespaceLine) paragraph += 1;
        whitespaceLine = true;
      } else if (source[index] !== CODE_MASK && !/\s/.test(source[index])) {
        whitespaceLine = false;
      }
    }
    result[source.length] = paragraph;
    return result;
  };
  const stripBoundedInlineHtml = (value) => {
    const pieces = [];
    tokenizeHtml(value, {
      onText: (text) => pieces.push(text),
      onTag: (tag) => {
        if (tag.name === 'em' || tag.name === 'i') pieces.push('_');
      },
    });
    return pieces.join('');
  };

  // Inspect bounded HTML alternatives with one quote-aware scan. Frame bodies
  // refer to the shared compact rendered stream; no close operation slices or
  // re-renders a nested body. Prefix checks are capped at a fixed size.
  const assertRenderedHtmlAlternatives = (source) => {
    const paragraphs = paragraphAt(source);
    const compact = [];
    const frames = [];
    const pendingPayloads = [];
    let pendingIndex = 0;
    let currentParagraph = paragraphs[0];
    let lineVisible = false;
    let hasTargetTag = false;
    let hasDanglingClosingTag = false;
    const prefixLimit = 128;
    const compactStartsWith = (start, expected) => {
      if (compact.length - start < expected.length) return false;
      for (let offset = 0; offset < expected.length; offset += 1) {
        if (compact[start + offset].toLowerCase() !== expected[offset]) return false;
      }
      return true;
    };
    const compactPrefix = (start, end) => {
      const stop = Math.min(end, start + prefixLimit);
      let value = '';
      for (let index = start; index < stop; index += 1) value += compact[index];
      return value;
    };
    const fieldLabelAt = (start, end) => {
      const length = end - start;
      return AC_DECISION_FIELDS.some((field) => {
        const normalized = normalizedFieldLabel(field) + ':';
        return length === normalized.length && compactStartsWith(start, normalized);
      });
    };
    const failPending = (paragraph) => {
      while (pendingIndex < pendingPayloads.length && pendingPayloads[pendingIndex].paragraph < paragraph) {
        const pending = pendingPayloads[pendingIndex++];
        if (compact.length > pending.payloadStart) {
          assert.fail(`raw HTML rendered ${pending.kind} is not canonical`);
        }
      }
    };
    const advanceParagraph = (position) => {
      const paragraph = paragraphs[position];
      if (paragraph > currentParagraph) {
        failPending(paragraph);
        currentParagraph = paragraph;
      }
    };
    const appendText = (value) => {
      // Decode each literal-source-line segment separately. A decoded newline
      // entity is whitespace in the source text, not a physical source-line
      // boundary; only a literal newline resets line visibility.
      const segments = value.split('\n');
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const decoded = decodeEntities(segments[segmentIndex]);
        for (let index = 0; index < decoded.length; index += 1) {
          if (decoded[index] === CODE_MASK) continue;
          if (!/\s/.test(decoded[index])) lineVisible = true;
          if (!/\s/.test(decoded[index])) compact.push(decoded[index]);
        }
        if (segmentIndex + 1 < segments.length) lineVisible = false;
      }
    };

    const processTag = (tag, start, end) => {
      advanceParagraph(start);
      if (!targetTagNames.has(tag.name)) {
        advanceParagraph(end);
        return;
      }
      hasTargetTag = true;
      if (!tag.closing) {
        frames.push({
          name: tag.name,
          compactStart: compact.length,
          lineStart: !lineVisible,
        });
      } else {
        const frame = frames.at(-1);
        if (!frame || frame.name !== tag.name) {
          hasDanglingClosingTag = true;
        } else {
          frames.pop();
          const bodyStart = frame.compactStart;
          const bodyEnd = compact.length;
          // Classify from the bounded rendered range. `compact` has already
          // removed rendered whitespace and decoded entities, so the prefix
          // starts at the first visible character even after arbitrary source
          // whitespace. Escape restoration is deliberately bounded to this
          // fixed prefix rather than to the raw wrapper body.
          const bodyPrefix = compactPrefix(bodyStart, bodyEnd);
          const bodyVariants = structuralVariants(bodyPrefix);
          const decisionBody = bodyVariants.some((variant) => decisionLike.test(`## ${variant}`));
          const renderedBodyVariants = bodyVariants.map((variant) =>
            normalizedFieldLabel(restoreEscapedPunctuation(variant)),
          );
          const clausesExactBody = renderedBodyVariants.some((variant) => variant === 'clauses:');
          const clausesPayloadBody = renderedBodyVariants.some((variant) =>
            variant.startsWith('clauses:') && variant !== 'clauses:',
          );
          const fieldBody = renderedBodyVariants.some((variant) => isDECFieldLabel(variant));
          const fieldPayloadBody = renderedBodyVariants.some((variant) =>
            AC_DECISION_FIELDS.some((field) => {
              const label = normalizedFieldLabel(field) + ':';
              return variant.startsWith(label) && variant !== label;
            }),
          );
          if (frame.name.startsWith('h') && frame.lineStart && (decisionLike.test(bodyPrefix) || decisionBody)) {
            assert.fail('raw HTML rendered decision heading is not canonical');
          }
          if ((frame.name === 'strong' || frame.name === 'b') && frame.lineStart && clausesPayloadBody) {
            assert.fail('raw HTML rendered Clauses metadata is not canonical');
          }
          if ((frame.name === 'em' || frame.name === 'i') && frame.lineStart && fieldPayloadBody) {
            assert.fail('raw HTML rendered DEC field is not canonical');
          }
          if ((frame.name === 'em' || frame.name === 'i') && frame.lineStart &&
            (fieldBody || fieldLabelAt(bodyStart, bodyEnd))) {
            pendingPayloads.push({ paragraph: paragraphs[end], payloadStart: compact.length, kind: 'DEC field' });
          } else if ((frame.name === 'strong' || frame.name === 'b') && frame.lineStart && clausesExactBody) {
            pendingPayloads.push({ paragraph: paragraphs[end], payloadStart: compact.length, kind: 'Clauses metadata' });
          }
        }
      }
      advanceParagraph(end);
    };
    const processText = (value, start, end) => {
      advanceParagraph(start);
      let textStart = start;
      while (textStart < end) {
        let boundary = textStart + 1;
        while (boundary < end && paragraphs[boundary] === currentParagraph) boundary += 1;
        appendText(source.slice(textStart, boundary));
        textStart = boundary;
        advanceParagraph(textStart);
      }
    };
    tokenizeHtml(source, { onText: processText, onTag: processTag });
    failPending(Number.MAX_SAFE_INTEGER);
    if (hasTargetTag && (hasDanglingClosingTag || frames.length > 0)) {
      assert.fail('raw HTML structural tag is not canonical');
    }
  };

  // Parse paragraph-start emphasis candidates into an emphasized body and a
  // payload. This avoids a generated alternation per mutation and keeps each
  // structural variant linear with a suffix payload check.
  const assertParagraphEmphasisAlternatives = (source) => {
    const paragraphs = source.split(/\n[ \t]*\n/);
    const fieldLabels = AC_DECISION_FIELDS.map((field) => normalizedFieldLabel(field) + ':');
    const emphasisScanLimit = 256;
    const bodyClass = (body) => {
      const compact = normalizedFieldLabel(body);
      if (fieldLabels.some((label) => compact === label || compact.startsWith(label))) return 'DEC field';
      if (compact === 'clauses:' || compact.startsWith('clauses:')) return 'Clauses metadata';
      return null;
    };
    const findBoundedDelimiter = (text, start, opener) => {
      const end = Math.min(text.length, start + emphasisScanLimit);
      for (let index = start + opener.length; index < end; index += 1) {
        if (text.startsWith(opener, index)) return index;
      }
      return -1;
    };
    const parseCandidate = (text, start, hasPayload) => {
      let opener = '';
      if (text.startsWith('***', start) || text.startsWith('___', start)) opener = text.slice(start, start + 3);
      else if (text[start] === '_') opener = '_';
      else return false;
      const close = findBoundedDelimiter(text, start, opener);
      if (close === -1) return false;
      const kind = bodyClass(text.slice(start + opener.length, close));
      if (!kind) return false;
      const bodyCompact = normalizedFieldLabel(text.slice(start + opener.length, close));
      const label = kind === 'Clauses metadata'
        ? 'clauses:'
        : fieldLabels.find((field) => bodyCompact.startsWith(field));
      if (bodyCompact !== label && bodyCompact.startsWith(label)) return true;
      return hasPayload(close + opener.length) ? kind : false;
    };
    const paragraphStructuralVariants = (value) => {
      // Keep literal source newlines as line boundaries, while decoded newline
      // references remain whitespace inside the same source line.
      const decodeLine = (line) => decodeEntities(line).replace(/\n/g, ' ');
      const decodeBySourceLine = (text) => text.split('\n').map(decodeLine).join('\n');
      const restored = restoreEscapedPunctuation(value);
      const decoded = decodeBySourceLine(value);
      return [...new Set([
        decoded,
        decodeBySourceLine(restored),
        restoreEscapedPunctuation(decoded),
      ])];
    };
    for (const paragraph of paragraphs) {
      const candidate = stripBoundedInlineHtml(paragraph);
      for (const variant of paragraphStructuralVariants(candidate)) {
        const suffix = new Uint8Array(variant.length + 1);
        for (let index = variant.length - 1; index >= 0; index -= 1) {
          suffix[index] = suffix[index + 1] ||
            (variant[index] !== CODE_MASK && /\S/.test(variant[index]) ? 1 : 0);
        }
        const hasPayload = (from) => suffix[from] === 1;
        for (let lineStart = 0; lineStart < variant.length;) {
          const lineEnd = variant.indexOf('\n', lineStart);
          const end = lineEnd === -1 ? variant.length : lineEnd;
          let start = lineStart;
          while (start < end && /[ \t]/.test(variant[start])) start += 1;
          const result = parseCandidate(variant, start, hasPayload);
          if (result) assert.fail(`paragraph-bounded rendered ${result} is not canonical`);
          lineStart = lineEnd === -1 ? variant.length : lineEnd + 1;
        }
      }
    }
  };

  const { structuralSource } = projection;
  assertRenderedHtmlAlternatives(structuralSource);
  assertParagraphEmphasisAlternatives(structuralSource);

  const lines = structuralSource.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const underline = /^\s*[-=]{3,}\s*$/.test(line);
    const setextText = index > 0 ? lines[index - 1].trim() : '';
    const setextVariants = structuralVariants(setextText);
    if (underline && decisionLike.test(setextText)) {
      assert.fail(`non-canonical Setext decision heading: ${setextText}`);
    }
    for (const variant of setextVariants.slice(1)) {
      if (underline && decisionLike.test(variant)) {
        assert.fail(`escaped Setext decision heading is not canonical: ${setextText}`);
      }
    }

    // Entity references are rejected only when their bounded rendering is a
    // reserved heading, Clauses metadata, or DEC field. Ordinary entity prose
    // such as `## R&D &amp; governance` remains valid.
    if (entity.test(line)) {
      const decodedLine = decodeEntities(line);
      if (isDecisionHeading(decodedLine)) {
        assert.fail(`HTML entity in decision H2 is not canonical: ${line}`);
      }
      if (isClausesMetadata(decodedLine)) {
        assert.fail(`HTML entity in Clauses metadata is not canonical: ${line}`);
      }
      if (reservedDECField(decodedLine)) {
        assert.fail(`composed DEC field is not canonical: ${line}`);
      }
    }

    // Underscore strong is valid ordinary prose, but it is not a canonical
    // ownership record. Parse only a full-line `__body__<separator><payload>`
    // shape. The reserved body is recognized after bounded decoding, or after
    // removing entity tokens solely to expose an obfuscated `Clauses:` body.
    if (isReservedOwnership(line)) {
      assert.fail(`non-canonical Clauses metadata: ${line}`);
    }

    // Only H2-shaped lines are considered here; ordinary H2 prose such as
    // `## Notes` remains valid and is not part of the decision inventory.
    if (/^\s*##(?!#)/.test(line) && decisionLike.test(line)) {
      assert.match(line, canonicalHeading, `non-canonical decision heading: ${line}`);
    }
    // A line beginning with the metadata token is metadata-like even when its
    // spacing is malformed. Inline prose mentions are deliberately ignored.
    if (/^\s*\*\*Clauses:\*\*/.test(line)) {
      assert.match(line, canonicalMetadata, `non-canonical Clauses metadata: ${line}`);
    }

    // CommonMark permits backslash escapes for ASCII punctuation. Apply one
    // bounded composition set to every line; ordinary prose remains valid when
    // none of its changed variants matches reserved structure.
    const variants = structuralVariants(line);
    for (const variant of variants.slice(1)) {
      if (isDecisionHeading(variant)) {
        assert.fail(`escaped decision heading is not canonical: ${line}`);
      }
      if (isClausesMetadata(variant) || isReservedOwnership(variant) || isTripleClausesOwnership(variant)) {
        assert.fail(`escaped Clauses metadata is not canonical: ${line}`);
      }
      if (isSingleDECFieldAlternative(variant)) {
        assert.fail(`escaped DEC field is not canonical: ${line}`);
      }
      if (reservedDECField(variant)) {
        assert.fail(`escaped DEC field or entity-composed DEC field is not canonical: ${line}`);
      }
    }

    // These emphasis forms render reserved ownership/DEC-field alternatives,
    // but only when the complete line is the bounded record-shaped form.
    if (isSingleDECFieldAlternative(line) || isTripleClausesOwnership(line)) {
      assert.fail(`rendered reserved alternative is not canonical: ${line}`);
    }
  }
}

function parseRecord(text) {
  assert.equal(typeof text, 'string', 'contract record must be text');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const projection = projectMarkdownCodeContext(normalized);
  const { masked, codeLines, lineIndexByStart } = projection;
  assertCanonicalRecordLines(normalized, projection);
  const headingPattern = /^## ([A-Z][A-Z0-9-]*) — (?:\S(?:.*\S)?)$/gm;
  const headings = [...masked.matchAll(headingPattern)];
  assert.ok(headings.length > 0, 'contract record has no decision sections');
  const recordLines = normalized.split('\n');
  const maskedLines = masked.split('\n');
  const headingLines = new Set(
    headings.map((heading) => lineIndexByStart.get(heading.index)),
  );
  for (let lineIndex = 0; lineIndex < recordLines.length; lineIndex += 1) {
    if (!codeLines[lineIndex] && /^\*\*Clauses:\*\*/.test(maskedLines[lineIndex])) {
      assert.ok(
        headingLines.has(lineIndex - 1),
        `Clauses metadata must immediately follow one parsed canonical decision H2 (line ${lineIndex + 1})`,
      );
    }
  }
  const sections = new Map();

  headings.forEach((heading, index) => {
    const id = heading[1];
    assert.ok(!sections.has(id), `duplicate decision heading: ${id}`);
    const start = heading.index;
    const end = index + 1 < headings.length ? headings[index + 1].index : normalized.length;
    const startLine = lineIndexByStart.get(start);
    const endLine = index + 1 < headings.length
      ? lineIndexByStart.get(end)
      : recordLines.length;
    const visibleLines = [];
    const visibleMaskedLines = [];
    for (let lineIndex = startLine; lineIndex < endLine; lineIndex += 1) {
      if (!codeLines[lineIndex]) {
        visibleLines.push(recordLines[lineIndex]);
        visibleMaskedLines.push(maskedLines[lineIndex]);
      }
    }
    const metadata = visibleLines.filter((line, lineIndex) =>
      /^\*\*Clauses:\*\* /.test(visibleMaskedLines[lineIndex]),
    );
    const lines = visibleLines;
    const structuralLines = visibleMaskedLines;
    assert.equal(metadata.length, 1, `${id} must contain exactly one dedicated **Clauses:** line`);
    assert.match(structuralLines[1] || '', /^\*\*Clauses:\*\* /, `${id} metadata must immediately follow its heading`);
    if (id.startsWith('DEC-')) {
      assert.equal(lines.length >= AC_DECISION_FIELDS.length + 2, true, `${id} is missing canonical AC-DECISION fields`);
      for (const [offset, field] of AC_DECISION_FIELDS.entries()) {
        const line = lines[offset + 2] || '';
        assert.match(
          line,
          new RegExp(`^\\*${field}:\\* \\S`),
          `${id} field is missing or out of canonical order: ${field}`,
        );
        const escapedField = field.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
        const occurrences = structuralLines.filter((candidate) =>
          new RegExp(`^[ ]{0,3}\\*${escapedField}:\\*[ \\t]+\\S`).test(candidate),
        );
        assert.equal(
          occurrences.length,
          1,
          `${id} must contain exactly one canonical ${field} field`,
        );
      }
      assert.equal(lines[2], `*Decision ID:* ${id}`, `${id} Decision ID must match its heading exactly`);
    }

    const value = metadata[0].slice('**Clauses:** '.length);
    if (value === STRUCTURAL_VALUE) {
      sections.set(id, { id, structural: true, clauses: [] });
      return;
    }

    assert.ok(value.trim(), `${id} has empty clause ownership metadata`);
    const clauses = value.split(',').map((clauseId) => clauseId.trim());
    assert.ok(clauses.every(Boolean), `${id} has empty clause ownership entry`);
    assert.ok(!clauses.includes(STRUCTURAL_VALUE), `${id} mixes structural and concrete ownership`);
    assert.equal(new Set(clauses).size, clauses.length, `${id} claims a clause more than once`);
    for (const clauseId of clauses) {
      assert.match(clauseId, /^[A-Za-z][A-Za-z0-9-]*$/, `${id} has malformed clause ID: ${clauseId}`);
    }
    sections.set(id, { id, structural: false, clauses });
  });
  return sections;
}

function validateRecord(recordText, value = manifest) {
  const clauseIds = manifestClauseIds(value);
  const sections = parseRecord(recordText);

  for (const structuralId of STRUCTURAL_DECISIONS) {
    assert.ok(sections.has(structuralId), `expected structural decision is missing: ${structuralId}`);
    assert.ok(sections.get(structuralId).structural, `${structuralId} must be structural`);
  }

  // Ownership is semantic: a concrete marker names the decision section it
  // belongs to, while a null marker falls back to the clause's own ID. Exact
  // coverage alone must not permit a clause to be assigned arbitrarily.
  for (const clause of value.clauses) {
    const intendedOwner = decisionOf(clause);
    assert.ok(sections.has(intendedOwner), `${clause.id} has no intended decision section: ${intendedOwner}`);
    const section = sections.get(intendedOwner);
    assert.ok(!section.structural, `${clause.id} maps to structural decision ${intendedOwner}`);
    assert.ok(section.clauses.includes(clause.id), `${clause.id} is not owned by intended decision ${intendedOwner}`);
  }

  const ownedBy = new Map();
  for (const section of sections.values()) {
    if (section.structural) {
      assert.ok(
        STRUCTURAL_DECISIONS.has(section.id),
        `${section.id} is not an approved structural decision`,
      );
      continue;
    }
    assert.ok(section.clauses.length > 0, `${section.id} must own at least one clause`);
    for (const clauseId of section.clauses) {
      assert.ok(clauseIds.has(clauseId), `${section.id} claims stale or unknown clause: ${clauseId}`);
      assert.ok(!ownedBy.has(clauseId), `clause ${clauseId} is claimed by ${ownedBy.get(clauseId)} and ${section.id}`);
      ownedBy.set(clauseId, section.id);
    }
  }

  assert.deepEqual(
    [...ownedBy.keys()].sort(),
    [...clauseIds].sort(),
    'every manifest clause must have exactly one recorded owner',
  );
  return { sections, ownedBy };
}

function sectionOf(text, id) {
  const normalized = normalizeLf(text);
  const pattern = new RegExp(`^## ${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} — .+$`, 'm');
  const start = normalized.search(pattern);
  assert.notEqual(start, -1, `missing section ${id}`);
  const next = normalized.indexOf('\n## ', start + 1);
  return normalized.slice(start, next === -1 ? undefined : next);
}

function removeSection(text, id) {
  const section = sectionOf(text, id);
  return text.replace(`${section}\n`, '');
}

const recordText = () => normalizeLf(readText(RECORD));

test('the authoritative contract record exists and validates bidirectionally', () => {
  assert.ok(exists(RECORD), `${RECORD} is missing; CL-D26 makes it the authoritative record`);
  validateRecord(recordText());
});

test('CL-D2 section preserves settled findings and scope rules', () => {
  const section = sectionOf(recordText(), 'CL-D2');
  assert.match(section, /accepted-as-designed.*deferred.*not-applicable.*settled/s);
  assert.match(section, /requires materially new evidence to reopen/);
  assert.match(section, /out-of-scope improvement rather than a blocker/);
});

test('CL-D30 section owns the exact PR autofix supersession', () => {
  const section = sectionOf(recordText(), 'CL-D30');
  assert.match(section, /exact PR `autofix`/);
  assert.match(section, /bounded public-head loop/);
  assert.match(section, /one normal commit/);
  assert.match(section, /15\/5\/third-observation circuit breakers/);
  assert.match(section, /later command is a fresh run/);
});

// Provenance: the ownership and parser mutation cases are review-driven regression
// coverage for the Sol findings. The null-marker assertion specifically reproduces
// the mutation-discovered gap and is therefore retrospective reproduction, not RED.
test('a null marker maps directly to its clause ID and recorded ownership', () => {
  const parsed = validateRecord(recordText());
  const optedOut = manifest.clauses.filter((clause) => 'marker' in clause && clause.marker === null);
  assert.ok(optedOut.length > 0, 'no clause exercises the null-marker path any more; drop this test or keep one');
  for (const clause of optedOut) {
    assert.equal(decisionOf(clause), clause.id);
    assert.ok(parsed.ownedBy.has(clause.id), `${clause.id} has no direct recorded owner`);
    assert.ok(parsed.sections.get(parsed.ownedBy.get(clause.id)).clauses.includes(clause.id));
  }
});

test('the raw manifest has no duplicate object keys', () => {
  assert.doesNotThrow(() => assertUniqueJsonKeys(manifestSource));
});

test('duplicate manifest id and marker keys fail before JSON.parse', () => {
  const duplicateId = manifestSource.replace(
    '"id": "CL-D1-issue"',
    '"id": "CL-D1-issue", "id": "shadow-id"',
  );
  assert.throws(() => assertUniqueJsonKeys(duplicateId), /duplicate JSON object key: id/);

  const duplicateMarker = manifestSource.replace(
    '"marker": "CL-D1"',
    '"marker": "CL-D1", "marker": "shadow-marker"',
  );
  assert.throws(() => assertUniqueJsonKeys(duplicateMarker), /duplicate JSON object key: marker/);
});

test('marker ownership cannot be reassigned to an arbitrary decision', () => {
  const mutated = recordText()
    .replace('## CL-D28 — Mode-scoped publication boundary (historical no-publication rule)\n**Clauses:** CL-D28', '## CL-D28 — Mode-scoped publication boundary (historical no-publication rule)\n**Clauses:** AC-GRANT')
    .replace('## AC-GRANT — Run-scoped bounded publication grant\n**Clauses:** AC-GRANT', '## AC-GRANT — Run-scoped bounded publication grant\n**Clauses:** CL-D28');
  assert.throws(() => validateRecord(mutated), /not owned by intended decision/);

  // Retrospective reproduction of the Windows checkout failure: a synthetic
  // CRLF fixture must normalize before LF mutation anchors are applied.
  const syntheticFixture = ['before', 'mutation anchor', 'after'].join('\r\n');
  const normalized = normalizeLf(syntheticFixture);
  assert.equal(normalized, 'before\nmutation anchor\nafter');
  assert.equal(
    normalized.replace('mutation anchor\n', 'mutated\n'),
    'before\nmutated\nafter',
  );
  assert.doesNotMatch(recordText(), /\r/, 'record fixture must be normalized to LF at read time');
});

test('duplicate decision headings fail instead of being silently overwritten', () => {
  assert.throws(
    () => validateRecord(`${recordText()}\n## CL-D1 — duplicate\n**Clauses:** CL-D1-issue`),
    /duplicate decision heading: CL-D1/,
  );
});

test('decision-like H2 whitespace and empty-title mutations are rejected', () => {
  for (const heading of [
    '##  CL-D1 — duplicate',
    '  ## CL-D1 — duplicate',
    '## CL-D1 —',
    '## CL-D1 —   ',
    '## CL-D1  — duplicate',
  ]) {
    assert.throws(
      () => validateRecord(`${recordText()}\n${heading}\n**Clauses:** CL-D1-issue`),
      /non-canonical decision heading/,
      heading,
    );
  }
});

test('metadata-like whitespace and duplicate-line mutations are rejected', () => {
  for (const metadata of [
    '**Clauses:**CL-D28',
    ' **Clauses:** CL-D28',
    '**Clauses:**  CL-D28',
  ]) {
    assert.throws(
      () => validateRecord(recordText().replace('**Clauses:** CL-D28\n\n', `**Clauses:** CL-D28\n${metadata}\n\n`)),
      /non-canonical Clauses metadata/,
      metadata,
    );
  }
});

test('Setext decision-like headings and metadata mutations are rejected', () => {
  const mutation = [
    'CL-D1 — duplicate rendered setext H2',
    '-----------------------------------',
    '**Clauses:** CL-D28',
    recordText(),
  ].join('\n');
  assert.throws(() => validateRecord(mutation), /non-canonical Setext decision heading/);

  assert.throws(
    () => validateRecord(`**Clauses:** CL-D28\n${recordText()}`),
    /Clauses metadata must immediately follow/,
  );
  assert.throws(
    () => validateRecord(`${recordText()}\n**Clauses:** CL-D28`),
    /Clauses metadata must immediately follow/,
  );
});

test('escaped reserved Markdown grammar is rejected while ordinary prose remains valid', () => {
  const escapedDecision = '## CL\\-D1 — competing owner\n**Clauses\\:** CL-D1-issue';
  assert.throws(
    () => validateRecord(`${recordText()}\n${escapedDecision}`),
    /escaped decision heading|escaped Clauses metadata/,
  );
  assert.throws(
    () => validateRecord(`${recordText()}\n\\#\\# CL&#45;D1 — competing owner`),
    /escaped decision heading/,
  );
  assert.throws(
    () => validateRecord(`${recordText()}\n\\*\\*Claus&#101;s\\:\\*\\* CL-D1-issue`),
    /escaped Clauses metadata/,
  );

  const escapedSetext = 'CL\\-D1 — competing owner\n----------------------------';
  assert.throws(
    () => validateRecord(`${recordText()}\n${escapedSetext}`),
    /Setext decision heading/,
  );

  assert.throws(
    () => validateRecord(`${recordText()}\n__Clauses\\:__ CL-D28`),
    /escaped Clauses metadata/,
  );
  assert.throws(
    () => validateRecord(`${recordText()}\n\\*\\*Clauses:\\*\\* CL-D1-issue`),
    /escaped Clauses metadata/,
  );

  const section = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  const canonicalField = '*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.';
  const escapedField = section.replace(
    canonicalField,
    `*Owner choice\\:* duplicate\n${canonicalField}`,
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, escapedField)),
    /escaped DEC field/,
  );
  const escapedFieldDelimiters = section.replace(
    canonicalField,
    `\\*Owner choice:\\* duplicate\n${canonicalField}`,
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, escapedFieldDelimiters)),
    /escaped DEC field/,
  );

  const validityField = '*Validity and invalidation conditions:* Holds while the MVP reports rather than enforces the observation window and takes a fresh snapshot on every run. If #4 enforces timing or needs to distinguish edits from re-fetches, revisit this decision with code.';
  const entityAfterFields = section.replace(
    validityField,
    `${validityField}\n*Owner choic&#101;\\:* duplicate`,
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, entityAfterFields)),
    /composed DEC field/,
  );
  const entityOnlyField = section.replace(
    validityField,
    `${validityField}\n*Owner choic&#101;:* duplicate`,
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, entityOnlyField)),
    /composed DEC field/,
  );
  const reverseCompositionField = section.replace(
    validityField,
    `${validityField}\n*Owner choic\\&#101;:* duplicate`,
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, reverseCompositionField)),
    /composed DEC field/,
  );

  for (const prose of [
    `${recordText()}\nThis is \\*ordinary\\* prose with \\[escaped punctuation\\].`,
    `${recordText()}\nThe prose says DEC\\-ision and CL\\-example without reserved structure.`,
    `${recordText()}\nThe literal text \\*Owner choice\\:* is not a field here.`,
    `${recordText()}\nThis \\*literal &copy;\\* remains ordinary prose.`,
    `${recordText()}\nThe prose \\#\\# CL&#45;example remains ordinary.`,
    `${recordText()}\nThe prose \\*\\*Claus&#101;s\\:\\*\\* remains ordinary.`,
  ]) {
    assert.doesNotThrow(() => validateRecord(prose), prose);
  }
});

test('invalid numeric entities remain unchanged in ordinary prose', () => {
  for (const entityReference of [
    '&#1114112;',
    '&#999999999999999999999999999999999999999999;',
    '&#x110000;',
    '&#xD800;',
    '&#xDC00;',
    '&#55296;',
  ]) {
    assert.doesNotThrow(
      () => validateRecord(`${recordText()}\nThe prose keeps ${entityReference} unchanged.`),
      entityReference,
    );
  }
});

test('ownership candidate rejection remains linear for long nonmatching spaces', () => {
  const nonmatching = `____${' '.repeat(4096)}`;
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n${nonmatching}`));
});

test('emphasis delimiter scans stay bounded across long nonmatching paragraphs', () => {
  const lines = Array.from({ length: 4096 }, (_, index) =>
    index % 2 === 0 ? `_${'x'.repeat(32)}` : `***${'y'.repeat(32)}`,
  ).join('\n');
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n${lines}`));
});

test('HTML tokenizer remains monotonic across malformed candidates and finds later tags', () => {
  const malformed = '<a'.repeat(4096);
  assert.throws(
    () => validateRecord(`${recordText()}\n${malformed}\n<strong>Clauses:</strong> CL-D28`),
    /raw HTML rendered Clauses metadata/,
  );
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n${malformed}\n<span><b>ordinary</b></span>`));
});

test('nested recognized HTML uses bounded shared rendering state', () => {
  const depth = 2048;
  const nested = `${'<em>'.repeat(depth)}ordinary nested prose${'</em>'.repeat(depth)}`;
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n${nested}`));
});

test('rendered HTML and entity grammar mutations are rejected', () => {
  for (const mutation of [
    '<h2>CL-D1 — competing owner</h2>\n<strong>Clauses:</strong> CL-D1-issue',
    '<H2 class="decision"> CL-D1 — competing owner </H2>\n<B data-kind="clauses"> Clauses: </B> CL-D1-issue',
    '<strong title=">">Clauses:</strong> CL-D28',
    '<strong>Clauses:</strong> CL-D28',
    '<strong>\nClauses: CL-D1-issue\n</strong>',
    '<strong>Claus&#101;s\\:</strong>\nCL-D28',
    '<span><strong>Clauses:</strong></span> CL-D28',
    '<span><b>Clauses:</b></span> CL-D28',
    '<span>\n<strong>Clauses:</strong></span> CL-D28',
    '<span>\n<em>Owner choice:</em></span> duplicate',
    '<span>\n<i>Rationale:</i></span> duplicate',
    '<span><h2>CL-D1 — competing owner</h2></span>',
    '<span data-x=">"><strong title=">">Clauses:</strong></span> CL-D28',
    '<span><em>Owner choice:</em></span> duplicate',
    '<span><i>Rationale:</i></span> duplicate',
    '<em title=">">Owner choice:</em> duplicate',
    '<em>Owner choice:</em>\nduplicate',
    '<em title=">">Rationale:</em> duplicate',
    '<em>Rationale:</em>\nduplicate',
    '<em>Owner choic&#101;\\:</em> duplicate',
    '<h2>CL\\-D1 — competing owner</h2>',
    '<h2>\nCL-D1 — competing owner\n</h2>\n<strong>\nClauses: CL-D1-issue\n</strong>',
    '<h2>\nCL-D1 — competing owner\n</h2>',
    '<strong>\nClauses: CL-D1-issue\n</strong>',
    '<h2\n>CL-D1 — competing owner</h2\n>\n<strong\n>Clauses: CL-D1-issue</strong\n>',
    '<h2\nclass="decision">CL-D1 — competing owner</h2\n>\n<strong\ndata-kind="clauses">Clauses: CL-D1-issue</strong\n>',
    '<h2><span>CL&#45;D1</span> — competing owner</h2>\n<strong>Cl&#97;uses:</strong> CL-D1-issue',
    'prefix </h4> suffix\ntext </b> suffix',
    '## C&#76;-D1 — competing owner\n**Claus&#101;s:** CL-D1-issue',
    '## CL-D1 &#8212; competing owner\n**Clauses&#58;** CL-D1-issue',
  ]) {
    assert.throws(
      () => validateRecord(`${recordText()}\n${mutation}`),
      /raw HTML|HTML entity/,
      mutation,
    );
  }
});

test('exact raw strong and b Clauses labels defer payload rejection', () => {
  const exact = [
    '<strong>Clauses:</strong>',
    '<b>Clauses:</b>',
    '<strong> Clauses: </strong>',
    '<b title=">"> Clauses: </b>',
    '<strong data-kind="clauses"><span>Clauses:</span></strong>',
    '<span><strong>Clauses:</strong></span>',
    '<span><b>Clauses:</b></span>',
    'ordinary <strong>Clauses:</strong> boundary',
    'ordinary <b>Clauses:</b> boundary',
    '<strong>Claus&#101;s\\:</strong>',
    '<b>Clau&#115;es&#58;</b>',
  ];
  for (const wrapper of exact) {
    assert.doesNotThrow(() => validateRecord(`${recordText()}\n${wrapper}`), wrapper);
  }

  for (const boundary of [
    '<strong>Clauses:</strong> CL-D28',
    '<b>Clauses:</b> CL-D28',
    '<strong>Clauses:</strong>\nCL-D28',
    '<b>Clauses:</b>\nCL-D28',
    '<span><strong>Clauses:</strong></span> CL-D28',
    '<span><b>Clauses:</b></span>\nCL-D28',
    '<strong>Claus&#101;s\\:</strong> CL-D28',
    '<b>Clau&#115;es&#58;</b>\nCL-D28',
  ]) {
    assert.throws(
      () => validateRecord(`${recordText()}\n${boundary}`),
      /raw HTML rendered Clauses metadata/,
      boundary,
    );
  }
});

test('rendered wrapper prefixes stay bounded by visible whitespace, not raw source length', () => {
  const counts = [127, 128, 129, 4096];
  const whitespace = (count, kind) => {
    if (kind === 'entity') return '&nbsp;'.repeat(count);
    if (kind === 'numeric') return '&#32;'.repeat(count);
    return ' '.repeat(count);
  };
  for (const count of counts) {
    for (const kind of ['literal', 'entity', 'numeric']) {
      const gap = whitespace(count, kind);
      for (const tag of ['strong', 'b']) {
        for (const label of ['Clauses:', 'Claus&#101;s\\:']) {
          const exact = `<${tag}>${gap}${label}</${tag}>`;
          assert.doesNotThrow(() => validateRecord(`${recordText()}\n${exact}`), `${tag}/${count}/${kind}/${label}`);
          assert.throws(
            () => validateRecord(`${recordText()}\n${exact} CL-D28`),
            /raw HTML rendered Clauses metadata/,
            `${tag}/${count}/${kind}/${label} external payload`,
          );
          assert.throws(
            () => validateRecord(`${recordText()}\n<${tag}>${gap}${label} CL-D28</${tag}>`),
            /raw HTML rendered Clauses metadata|paragraph-bounded rendered/,
            `${tag}/${count}/${kind}/${label} body payload`,
          );
          assert.throws(
            () => validateRecord(`${recordText()}\n<${tag}><span>${gap}${label}</span></${tag}> CL-D28`),
            /raw HTML rendered Clauses metadata/,
            `${tag}/${count}/${kind}/${label} nested external payload`,
          );
        }
      }
    }
  }
});

test('rendered DEC wrappers and headings classify all labels after long whitespace', () => {
  const counts = [127, 128, 129, 4096];
  const gaps = (count) => [' '.repeat(count), '&nbsp;'.repeat(count), '&#32;'.repeat(count)];
  for (const field of AC_DECISION_FIELDS) {
    for (const count of counts) {
      for (const gap of gaps(count)) {
        for (const tag of ['em', 'i']) {
          const exact = `<${tag}>${gap}${field}:</${tag}>`;
          assert.doesNotThrow(() => validateRecord(`${recordText()}\n${exact}`), `${tag}/${field}/${count}`);
          assert.throws(
            () => validateRecord(`${recordText()}\n${exact} duplicate`),
            /raw HTML rendered DEC field/,
            `${tag}/${field}/${count} external payload`,
          );
          assert.throws(
            () => validateRecord(`${recordText()}\n<${tag}><span>${gap}${field}: duplicate</span></${tag}>`),
            /raw HTML rendered DEC field|paragraph-bounded rendered/,
            `${tag}/${field}/${count} body payload`,
          );
        }
      }
    }
  }
  for (const count of counts) {
    for (const gap of gaps(count)) {
      for (const tag of ['h2', 'h3']) {
        assert.throws(
          () => validateRecord(`${recordText()}\n<${tag}>${gap}CL-D1 — competing owner</${tag}>`),
          /raw HTML rendered decision heading/,
          `${tag}/${count}`,
        );
      }
    }
  }
});

test('bounded emphasis alternatives remain reserved while ordinary prose remains valid', () => {
  const section = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  const validityField = '*Validity and invalidation conditions:* Holds while the MVP reports rather than enforces the observation window and takes a fresh snapshot on every run. If #4 enforces timing or needs to distinguish edits from re-fetches, revisit this decision with code.';
  for (const alternative of [
    '_Owner choice:_ duplicate',
    '_Owner choice:_\nduplicate',
    '_<span>Owner choice:</span>_ duplicate',
    '_<span>Owner choic&#101;\\:</span>_\nduplicate',
    '<em>Owner choice:</em> duplicate',
    '<i>Owner choice:</i> duplicate',
    '_Rationale:_ duplicate',
    '_Rationale:_\nduplicate',
    '_<span>Rationale:</span>_ duplicate',
    '_<span>Rational&#101;\\:</span>_\nduplicate',
    '<em>Rationale:</em> duplicate',
    '<i>Rationale:</i> duplicate',
    '<em>Owner choice: duplicate</em>',
    '_Owner choice: duplicate_',
    '<em>Rationale: duplicate</em>',
    '_Rationale: duplicate_',
  ]) {
    assert.throws(
      () => validateRecord(recordText().replace(section, section.replace(validityField, `${validityField}\n${alternative}`))),
      /rendered reserved alternative|raw HTML rendered DEC field|paragraph-bounded rendered/,
      alternative,
    );
  }
  for (const alternative of [
    '***Clauses:*** CL-D28',
    '***Clauses:***\nCL-D28',
    '___Clauses:___ CL-D28',
    '___Clauses:___\nCL-D28',
    '***Claus&#101;s\\:***\nCL-D28',
    '***Clauses: CL-D28***',
    '___Clauses: CL-D28___',
  ]) {
    assert.throws(
      () => validateRecord(recordText().replace('**Clauses:** CL-D28\n', `**Clauses:** CL-D28\n${alternative}\n`)),
      /rendered reserved alternative|paragraph-bounded rendered/,
      alternative,
    );
  }

  for (const prose of [
    `${recordText()}\nThe _Owner choice:_ remains ordinary prose.`,
    `${recordText()}\nThe _Owner choice:_\nremains ordinary prose.`,
    `${recordText()}\nThe <em>Owner choice:</em> remains ordinary prose.`,
    `${recordText()}\nThe <em>Owner choice:</em>\nremains ordinary prose.`,
    `${recordText()}\nThe <i>Owner choice:</i> remains ordinary prose.`,
    `${recordText()}\nThe <b title=">">important</b> prose remains ordinary.`,
    `${recordText()}\n<span>prefix <strong>Clauses:</strong></span> CL-D28`,
    `${recordText()}\n<span>prefix<strong\n title=">">Clauses:</strong></span> CL-D28`,
    `${recordText()}\nprefix&NewLine;<span><strong>Clauses:</strong></span> CL-D28`,
    `${recordText()}\n<span>prefix<em\n title=">">Owner choice:</em></span> duplicate`,
    `${recordText()}\nprefix&NewLine;<span><em>Owner choice:</em></span> duplicate`,
    `${recordText()}\n<span>prefix<i\n title=">">Rationale:</i></span> duplicate`,
    `${recordText()}\nprefix&NewLine;<span><i>Rationale:</i></span> duplicate`,
    `${recordText()}\n<span><strong>important</strong></span>`,
    `${recordText()}\n<span data-x=">"><em>important</em></span>`,
    `${recordText()}\nThe <b>important</b>\nprose remains ordinary.`,
    `${recordText()}\nThe <em title=">">Rationale:</em> remains ordinary prose.`,
    `${recordText()}\nThe <em>Rational&#101;\\:</em> remains ordinary wrapper prose.`,
    `${recordText()}\nThe _Rationale:_ remains ordinary prose.`,
    `${recordText()}\nThe <em>Rationale:</em> remains ordinary prose.`,
    `${recordText()}\nThe <i>Rationale:</i> remains ordinary prose.`,
    `${recordText()}\nThe <em>Owner choice: duplicate</em> remains ordinary prose.`,
    `${recordText()}\nThe _Owner choice: duplicate_ remains ordinary prose.`,
    `${recordText()}\nThe ***Clauses: CL-D28*** remains ordinary prose.`,
    `${recordText()}\nThe ___Clauses: CL-D28___ remains ordinary prose.`,
    `${recordText()}\n_Owner choice:_\n\nordinary paragraph after a blank line.`,
    `${recordText()}\n_Owner choice:_&NewLine;`,
    `${recordText()}\nThe ***Clauses:*** phrase remains ordinary prose.`,
    `${recordText()}\nThe ___Clauses:___ phrase remains ordinary prose.`,
  ]) {
    assert.doesNotThrow(() => validateRecord(prose), prose);
  }
});

test('all DEC labels and Clauses compositions remain bounded reserved alternatives', () => {
  const section = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  const validityField = '*Validity and invalidation conditions:* Holds while the MVP reports rather than enforces the observation window and takes a fresh snapshot on every run. If #4 enforces timing or needs to distinguish edits from re-fetches, revisit this decision with code.';
  for (const field of AC_DECISION_FIELDS) {
    const split = Math.max(1, Math.floor(field.length / 2));
    const first = field.slice(0, split);
    const rest = field.slice(split);
    const entityFirst = `&#${field.charCodeAt(0)};`;
    for (const alternative of [
      `_${first}\n${rest}:_ duplicate`,
      `_<span>${first}</span>&NewLine;${rest}\\:_ duplicate`,
      `_<span>${entityFirst}${first.slice(1)}${rest}</span>&NewLine;\\:_ duplicate`,
    ]) {
      assert.throws(
        () => validateRecord(recordText().replace(section, section.replace(validityField, `${validityField}\n${alternative}`))),
        /paragraph-bounded rendered|raw HTML rendered DEC field|rendered reserved alternative/,
        `${field}: ${alternative}`,
      );
    }
  }
  for (const alternative of [
    '***Clau\nses:*** CL-D28',
    '___Clau&NewLine;ses\\:___ CL-D28',
    '***<span>Clau</span>&NewLine;ses\\:*** CL-D28',
    '___Cla&#117;ses\\:___ CL-D28',
  ]) {
    assert.throws(
      () => validateRecord(recordText().replace('**Clauses:** CL-D28\n', `**Clauses:** CL-D28\n${alternative}\n`)),
      /paragraph-bounded rendered|rendered reserved alternative/,
      alternative,
    );
  }
  for (const prose of [
    `${recordText()}\nThe _Decision\nID:_ remains ordinary prose.`,
    `${recordText()}\nThe ***Clau\nses:*** phrase remains ordinary prose.`,
  ]) {
    assert.doesNotThrow(() => validateRecord(prose), prose);
  }
});

test('alternate underscore ownership metadata is rejected', () => {
  for (const mutation of [
    '__Clauses:__ CL-D28',
    '__clauses : __ CL-D28',
    '__CL&#97;uses&#58;__ CL&#45;D28',
    '__CLAUSES:\u00a0__ CL-D28',
    '__Clauses&nbsp;:__ CL-D28',
    '__Clauses:&nbsp;__ CL-D28',
    '__Clauses:__&nbsp;CL-D28',
    '__cLaUsEs&nbsp;:__ CL-D28',
    '__Clauses&ZeroWidthSpace;:__ CL-D28',
    '__Clauses&VeryThinSpace;:__ CL-D28',
    '__Clauses&NegativeThinSpace;:__ CL-D28',
    '__Clauses:__&nbsp;CL-D28',
    '__Clauses:__\u00a0CL-D28',
    '__Clauses:__\u2003CL-D28',
    '__Clauses:__\u202fCL-D28',
    '__Clauses:__&ensp;CL-D28',
    '__Clauses:__&emsp;CL-D28',
    '__Clauses:__&#32;CL-D28',
    '__Clauses:__&#x20;CL-D28',
    '__Clau&ZeroWidthSpace;ses&copy;:__ CL-D28',
    '__Clau&ZeroWidthSpace;ses&colon;__ CL-D28',
    '__Clau&NegativeThinSpace;ses&colon;__ CL-D28',
    '__Clau&#8203;ses&#58;__ CL-D28',
  ]) {
    assert.throws(
      () => validateRecord(`${recordText()}\n${mutation}`),
      /non-canonical Clauses metadata/,
      mutation,
    );
  }
});

test('every DEC decision preserves the complete AC-DECISION field record', () => {
  const fields = [
    'Decision ID',
    'Kind',
    'Target and revision',
    'Question',
    'Options and trade-offs',
    'Recommendation',
    'Owner choice',
    'Rationale',
    'Validity and invalidation conditions',
  ];
  const section = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  for (const field of fields) {
    const mutation = section.replace(new RegExp(`^\\*${field}:\\* .*\\n?`, 'm'), '');
    assert.throws(
      () => validateRecord(recordText().replace(section, mutation)),
      new RegExp(`DEC-EXT-SNAPSHOT-001 field is missing or out of canonical order: ${field}`),
      field,
    );
  }
});

test('DEC duplicate field mutations reject indentation and tabs across line endings', () => {
  const canonical = '*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.';
  for (const duplicate of [
    '*Owner choice:*\tduplicate',
    '*Owner choice:*  duplicate',
    ' *Owner choice:* duplicate',
  ]) {
    for (const source of [recordText(), recordText().replace(/\r?\n/g, '\r\n')]) {
      const lineBreak = source.includes('\r\n') ? '\r\n' : '\n';
      const mutated = source.replace(canonical, `${canonical}${lineBreak}${duplicate}`);
      assert.throws(
        () => validateRecord(mutated),
        /must contain exactly one canonical Owner choice field/,
        `${JSON.stringify(duplicate)} with ${source.includes('\r\n') ? 'CRLF' : 'LF'}`,
      );
    }
  }
});

test('ordinary horizontal rules and nondecision Setext headings remain valid', () => {
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n## Notes\nNotes\n---\n`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\nRelease notes\n===\n`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n## Notes\nThe prose mentions **Clauses:** inline.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n<p>ordinary HTML prose</p>`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n## R&D &amp; governance`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n## R&D &#38; governance`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n**Copyright &copy; 2026**`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n**Copyright &#169; 2026**`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\nThe <b>important</b> prose remains ordinary.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\nThe <b>\nimportant\n</b> prose remains ordinary.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\nThe __important__ prose remains ordinary.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n__Copyright: &copy;__ remains ordinary prose.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n__The clauses &amp; conditions__ remain ordinary prose.`));
});

test('line-start backtick delimiters leave enclosed reserved forms ordinary', () => {
  for (const source of [
    `${recordText()}\n\`<strong>Clauses:</strong> CL-D28\``,
    `${recordText()}\n\`\`<strong>Clauses:</strong> CL-D28\`\``,
    `${recordText()}\n\`\`\`<strong>Clauses:</strong> CL-D28\`\`\``,
    `${recordText()}\n\`## CL-D1 — literal\``,
    `${recordText()}\n\`\`## CL-D1 — literal\`\``,
    `${recordText()}\n\`\`\`## CL-D1 — literal\`\`\``,
    `${recordText()}\n\`**Clauses:** CL-D28\``,
    `${recordText()}\n\`\`**Clauses:** CL-D28\`\``,
  ]) {
    assert.doesNotThrow(() => validateRecord(source), JSON.stringify(source.slice(-160)));
  }
});

test('fenced and indented code masks all structural record scanners', () => {
  const code = [
    '```markdown',
    '<strong>Clauses:</strong> CL-D28',
    '<em>Owner choice:</em> duplicate',
    '__Clauses:__ CL-D28',
    '## CL-D1 — literal decision',
    '**Clauses:** CL-D1-issue',
    'CL-D1 — literal Setext',
    '----------------------',
    '\\#\\# CL\\-D1 — escaped decision',
    '\\*\\*Clauses:\\*\\* CL-D1-issue',
    '_Owner choice:_ duplicate',
    '*Owner choice:* duplicate',
    '```',
    '~~~',
    '## CL-D2 — tilde literal',
    '**Clauses:** CL-D2',
    '~~',
    '```',
    '~~~',
  ].join('\n');
  for (const source of [
    `${recordText()}\n${code}`,
    `${recordText()}\n${code}\n` + '```' + '\n## CL-D3 — unterminated literal',
    `${recordText()}\n${code}`.replace(/\n/g, '\r\n'),
    `${recordText()}\n    **Clauses:** CL-D28`,
    `${recordText()}\n    <em>Owner choice:</em> duplicate\n\n    <em>Rationale:</em> duplicate`,
    `${recordText()}\n\t<em>Owner choice:</em> duplicate`,
  ]) {
    assert.doesNotThrow(() => validateRecord(source), JSON.stringify(source.slice(-160)));
  }

  for (const outside of [
    '##  CL-D1 — malformed immediately after fence',
    '<strong>Clauses:</strong> CL-D28',
  ]) {
    const closed = `${recordText()}\n${outside}\n~~~\nliteral\n~~~`;
    assert.throws(() => validateRecord(closed), /non-canonical decision heading|raw HTML rendered Clauses metadata/);
    const after = `${recordText()}\n~~~\nliteral\n~~~\n${outside}`;
    assert.throws(() => validateRecord(after), /non-canonical decision heading|raw HTML rendered Clauses metadata/);
  }

  // TERRA-R2-001: a pending exact rendered label cannot cross a closed fence
  // merely because the masked code lines look blank. Code-only lines are absent
  // from structural paragraphs; only a real non-code blank line is a boundary.
  const pendingLabels = [
    ['<strong>Clauses:</strong>', 'CL-D28', /raw HTML rendered Clauses metadata/],
    ['<b>Clauses:</b>', 'CL-D28', /raw HTML rendered Clauses metadata/],
    ['_Owner choice:_', 'duplicate', /paragraph-bounded rendered DEC field/],
    ['***Clauses:***', 'CL-D28', /paragraph-bounded rendered Clauses metadata/],
  ];
  for (const lineEnding of ['\n', '\r\n']) {
    const toLineEnding = (source) => lineEnding === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
    for (const marker of ['```', '~~~']) {
      const cases = [
        `${marker}\n${marker}`, // empty fence
        `${marker}\nliteral\n${marker}`, // nonempty fence
        `${marker}\n\n\n${marker}`, // blank code lines
        `${marker}\nliteral\n${marker}${marker}`, // longer valid closer
      ];
      for (const [label, payload, expected] of pendingLabels) {
        for (const fence of cases) {
          const source = toLineEnding(`${recordText()}\n${label}\n${fence}\n${payload}`);
          assert.throws(() => validateRecord(source), expected, `${label} ${marker} ${JSON.stringify(fence)}`);
        }
        const boundary = toLineEnding(`${recordText()}\n${label}\n\n${payload}`);
        assert.doesNotThrow(
          () => validateRecord(boundary),
          `ordinary blank line must remain a paragraph boundary: ${label}`,
        );

        const fenced = toLineEnding(`${recordText()}\n${marker}\n${label} ${payload}\n${marker}`);
        assert.doesNotThrow(() => validateRecord(fenced), `fully fenced: ${label} ${marker}`);
        const unterminated = toLineEnding(`${recordText()}\n${marker}\n${label} ${payload}\n\n`);
        assert.doesNotThrow(() => validateRecord(unterminated), `unterminated: ${label} ${marker}`);
        const afterClosed = toLineEnding(`${recordText()}\n${marker}\nliteral\n${marker}\n${label} ${payload}`);
        assert.throws(() => validateRecord(afterClosed), expected, `after closed fence: ${label} ${marker}`);
      }
    }
  }

  // Setext inventory follows the same code-line-removed source: a candidate
  // immediately followed by a rule across a fence is still one structural pair.
  for (const lineEnding of ['\n', '\r\n']) {
    const toLineEnding = (source) => lineEnding === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
    const source = toLineEnding(`${recordText()}\nCL-D1 — competing owner\n` +
      '```\nliteral\n```\n---');
    assert.throws(() => validateRecord(source), /non-canonical Setext decision heading/);
  }

  // DEC parsing removes code by explicit line membership, not by inspecting
  // masked characters: blank fenced lines have no characters to mask.
  const decSection = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  const metadata = '**Clauses:** none — structural\n';
  for (const lineEnding of ['\n', '\r\n']) {
    for (const marker of ['```', '~~~']) {
      const toLineEnding = (source) => lineEnding === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
      const closed = decSection.replace(
        metadata,
        `${metadata}${marker}markdown\n*Owner choice:* duplicate\n\n\n${marker}\n`,
      );
      assert.doesNotThrow(() => parseRecord(toLineEnding(closed)), `${marker} closed ${lineEnding}`);

      const unterminated = `${decSection}${marker}\n*Owner choice:* duplicate\n\n\n`;
      assert.doesNotThrow(
        () => parseRecord(toLineEnding(unterminated)),
        `${marker} unterminated ${lineEnding}`,
      );
    }
  }
});

test('DEC decision fields reject duplicates, mismatched IDs, and reordering', () => {
  const section = sectionOf(recordText(), 'DEC-EXT-SNAPSHOT-001');
  const duplicate = section.replace(
    '*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.\n',
    '*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.\n*Owner choice:* duplicate\n',
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, duplicate)),
    /must contain exactly one canonical Owner choice field/,
  );

  const mismatch = section.replace('*Decision ID:* DEC-EXT-SNAPSHOT-001', '*Decision ID:* DEC-OTHER');
  assert.throws(
    () => validateRecord(recordText().replace(section, mismatch)),
    /Decision ID must match its heading exactly/,
  );

  const reordered = section.replace(
    '*Question:* CL-D24 and CL-D13 required a digest of observed external events so a resume could detect edits, while CL-D28 removed that byte-exact specification from this MVP.\n*Options and trade-offs:*',
    '*Options and trade-offs:* Define a canonical event serialization in the Skill; withdraw the digest and re-fetch on resume; or defer external resume until #4. Defining serialization repeats the under-specified prose machinery rejected by CL-D28, while deferring resume loses honest observation continuity.\n*Question:*',
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, reordered)),
    /field is missing or out of canonical order: Question/,
  );

  // A blank line outside code remains structural and therefore still shifts the
  // strict positional DEC field order.
  const blankOutsideCode = section.replace(
    '*Question:* CL-D24 and CL-D13 required a digest of observed external events so a resume could detect edits, while CL-D28 removed that byte-exact specification from this MVP.\n*Options and trade-offs:*',
    '*Question:* CL-D24 and CL-D13 required a digest of observed external events so a resume could detect edits, while CL-D28 removed that byte-exact specification from this MVP.\n\n*Options and trade-offs:*',
  );
  assert.throws(
    () => validateRecord(recordText().replace(section, blankOutsideCode)),
    /field is missing or out of canonical order: Options and trade-offs/,
  );
});

test('adding a clause under an existing marker without recording it fails', () => {
  const mutated = structuredClone(manifest);
  mutated.clauses.push({
    id: 'CL-D2-added',
    marker: 'CL-D2',
    title: 'mutation',
    files: ['skills/closed-loop-pr/SKILL.md'],
    requires: ['mutation'],
  });
  assert.throws(() => validateRecord(recordText(), mutated), /not owned by intended decision CL-D2|exactly one recorded owner/);
});

test('stale ownership fails', () => {
  const mutated = recordText().replace('**Clauses:** CL-D1-issue, CL-D1-pr', '**Clauses:** CL-D1-stale, CL-D1-pr');
  assert.throws(() => validateRecord(mutated), /not owned by intended decision CL-D1|stale or unknown clause: CL-D1-stale/);
});

test('removing an expected structural section fails', () => {
  assert.throws(() => validateRecord(removeSection(recordText(), 'CL-D21')), /expected structural decision is missing: CL-D21/);
});

test('structural-looking prose cannot bypass concrete ownership', () => {
  const mutated = recordText().replace(
    '**Clauses:** CL-D28\n\n',
    '**Clauses:** none — structural\n\nThis sentence says structural, but the decision remains enforceable.\n\n',
  );
  assert.throws(() => validateRecord(mutated), /CL-D28 maps to structural decision|CL-D28 is not an approved structural decision|exactly one recorded owner/);
});

test('malformed and duplicate ownership metadata fails', () => {
  assert.throws(() => validateRecord(recordText().replace('**Clauses:** CL-D2', '**Clauses:**')), /non-canonical Clauses metadata|exactly one dedicated/);
  assert.throws(
    () => validateRecord(recordText().replace('**Clauses:** CL-D2', '**Clauses:** CL-D2, CL-D2')),
    /claims a clause more than once/,
  );
});

test('the record is not shipped in the package', () => {
  const pkg = readJson('package.json');
  assert.ok(!pkg.files.includes(RECORD), `${RECORD} is a development record, not package payload; CL-D26 keeps it out of files`);
});

module.exports = { decisionOf, manifestClauseIds, parseRecord, validateRecord };

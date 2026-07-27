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
const STRUCTURAL_DECISIONS = new Set([
  'CL-D19',
  'CL-D21',
  'CL-D26',
  'DEC-EXT-SNAPSHOT-001',
]);
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

function assertCanonicalRecordLines(normalized) {
  const decisionLike = /(?:CL-D|AC-|DEC-)[A-Za-z0-9-]+/;
  const canonicalHeading = /^## [A-Z][A-Z0-9-]* — (?:\S(?:.*\S)?)$/;
  const canonicalMetadata = /^\*\*Clauses:\*\* \S(?:.*\S)?$/;
  const entity = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i;
  const entityGlobal = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi;
  const rawHtmlHeadingTag = /<\/?h[1-6]\b[^>]*>/i;
  const rawHtmlStrongTag = /<\/?(?:strong|b)\b[^>]*>/i;
  const decodeEntities = (value) => value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
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

  // Check the complete record before line processing so tags split across
  // newlines cannot evade the raw-HTML boundary.
  if (rawHtmlHeadingTag.test(normalized)) {
    assert.fail('raw HTML heading tag is not canonical');
  }
  if (rawHtmlStrongTag.test(normalized)) {
    assert.fail('raw HTML strong/b tag is not canonical');
  }

  const lines = normalized.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const underline = /^\s*[-=]{3,}\s*$/.test(line);
    const setextText = index > 0 ? lines[index - 1].trim() : '';
    if (underline && decisionLike.test(setextText)) {
      assert.fail(`non-canonical Setext decision heading: ${setextText}`);
    }

    // Entity references can make a non-matching raw line render as a heading or
    // ownership declaration. H2-shaped and bold-metadata-shaped lines must use
    // the canonical raw grammar regardless of their visible words.
    if (entity.test(line) && /^\s*##(?!#)/.test(line)) {
      assert.fail(`HTML entity in H2 line is not canonical: ${line}`);
    }
    if (entity.test(line) && /^\s*\*\*/.test(line)) {
      assert.fail(`HTML entity in bold metadata line is not canonical: ${line}`);
    }

    // Underscore strong is valid ordinary prose, but it is not a canonical
    // ownership record. Parse only a full-line `__body__<separator><payload>`
    // shape. The reserved body is recognized after bounded decoding, or after
    // removing entity tokens solely to expose an obfuscated `Clauses:` body.
    const ownershipMatch = line.match(/^\s*__([^_\n]*)__((?:(?:\s+)|(?:&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);))+)(\S(?:.*\S)?)\s*$/i);
    if (ownershipMatch) {
      const [, underscoreBody, separator] = ownershipMatch;
      const decodedBody = decodeEntities(underscoreBody);
      const strippedBody = underscoreBody.replace(entityGlobal, '');
      const normalizeReserved = (value) => value.replace(/\s+/g, '').toLowerCase() === 'clauses:';
      if (normalizeReserved(decodedBody) || normalizeReserved(strippedBody)) {
        assert.fail(`non-canonical Clauses metadata: ${line}`);
      }
      // Keep the separator binding explicit so entity payloads cannot turn
      // arbitrary underscore prose into a candidate.
      void separator;
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
  }
}

function parseRecord(text) {
  assert.equal(typeof text, 'string', 'contract record must be text');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  assertCanonicalRecordLines(normalized);
  const headingPattern = /^## ([A-Z][A-Z0-9-]*) — (?:\S(?:.*\S)?)$/gm;
  const headings = [...normalized.matchAll(headingPattern)];
  assert.ok(headings.length > 0, 'contract record has no decision sections');
  const lines = normalized.split('\n');
  const headingLines = new Set(
    headings.map((heading) => normalized.slice(0, heading.index).split('\n').length - 1),
  );
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (/^\*\*Clauses:\*\*/.test(lines[lineIndex])) {
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
    const lines = normalized.slice(start, end).split('\n');
    const metadata = lines.filter((line) => /^\*\*Clauses:\*\* /.test(line));
    assert.equal(metadata.length, 1, `${id} must contain exactly one dedicated **Clauses:** line`);
    assert.match(lines[1] || '', /^\*\*Clauses:\*\* /, `${id} metadata must immediately follow its heading`);
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
        const occurrences = lines.filter((candidate) =>
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
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

const recordText = () => readText(RECORD);

test('the authoritative contract record exists and validates bidirectionally', () => {
  assert.ok(exists(RECORD), `${RECORD} is missing; CL-D26 makes it the authoritative record`);
  validateRecord(recordText());
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
    .replace('## CL-D28 — The MVP does not publish\n**Clauses:** CL-D28', '## CL-D28 — The MVP does not publish\n**Clauses:** AC-GRANT')
    .replace('## AC-GRANT — Run-scoped publication grant\n**Clauses:** AC-GRANT', '## AC-GRANT — Run-scoped publication grant\n**Clauses:** CL-D28');
  assert.throws(() => validateRecord(mutated), /not owned by intended decision/);
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

test('rendered HTML and entity grammar mutations are rejected', () => {
  for (const mutation of [
    '<h2>CL-D1 — competing owner</h2>\n<strong>Clauses:</strong> CL-D1-issue',
    '<H2 class="decision"> CL-D1 — competing owner </H2>\n<B data-kind="clauses"> Clauses: </B> CL-D1-issue',
    '<h2>\nCL-D1 — competing owner\n</h2>\n<strong>\nClauses: CL-D1-issue\n</strong>',
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
  assert.doesNotThrow(() => validateRecord(`${recordText()}\nThe __important__ prose remains ordinary.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n__Copyright: &copy;__ remains ordinary prose.`));
  assert.doesNotThrow(() => validateRecord(`${recordText()}\n__The clauses &amp; conditions__ remain ordinary prose.`));
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

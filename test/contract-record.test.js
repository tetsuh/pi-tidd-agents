'use strict';

// CL-D26. CONTRACT.md is the authoritative record of the decisions this package
// implements, and test/contract-clauses.json is how those decisions are enforced
// against the shipped prose. The two must stay in step.
//
// Three contract changes reached main without a decision record while the record
// lived in a GitHub comment, because nothing could check a comment. A clause whose
// decision is undocumented, or a decision that quietly loses the clauses that
// enforce it, now fails the build instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, exists } = require('./helpers');

const RECORD = 'CONTRACT.md';
const STRUCTURAL = '**Clauses:** none — structural';

const manifest = readJson('test/contract-clauses.json');

// The decision a clause enforces is not the same thing as the marker it looks for
// in a file. `"marker": null` opts out of the in-file landmark for user-facing
// files such as README.md; it does not mean the clause enforces no decision. An
// earlier version conflated the two, so a clause could escape this check entirely
// by opting out of the marker — which a mutation check caught and review would not
// have, since the manifest and the record would both have looked complete.
const decisionOf = (clause) =>
  'marker' in clause && clause.marker !== null ? clause.marker : clause.id;

const markers = new Set(manifest.clauses.map(decisionOf));

function decisions(text) {
  const found = new Map();
  const pattern = /^## ([A-Z][A-Z0-9-]*) — .+$/gm;
  const lines = text.replace(/\r\n/g, '\n');
  let match;
  while ((match = pattern.exec(lines)) !== null) {
    const start = match.index;
    const next = lines.indexOf('\n## ', start + 1);
    found.set(match[1], lines.slice(start, next === -1 ? undefined : next));
  }
  return found;
}

test('the authoritative contract record exists', () => {
  assert.ok(exists(RECORD), `${RECORD} is missing; CL-D26 makes it the authoritative record`);
});

test('a clause that opts out of the in-file marker still enforces a decision', () => {
  const optedOut = manifest.clauses.filter((clause) => 'marker' in clause && clause.marker === null);
  assert.ok(optedOut.length > 0, 'no clause exercises the null-marker path any more; drop this test or keep one');
  for (const clause of optedOut) {
    assert.ok(
      markers.has(decisionOf(clause)),
      `${clause.id} opts out of the marker check and would escape the decision check too`,
    );
  }
});

test('every clause marker resolves to a decision in the record', () => {
  const documented = decisions(readText(RECORD));
  const orphans = [...markers].filter((marker) => !documented.has(marker));
  assert.deepEqual(
    orphans,
    [],
    `these clauses enforce decisions that ${RECORD} does not document: ${orphans.join(', ')}`,
  );
});

test('every decision owns a clause or is annotated structural', () => {
  const documented = decisions(readText(RECORD));
  const unenforced = [...documented]
    .filter(([id, section]) => !markers.has(id) && !section.includes(STRUCTURAL))
    .map(([id]) => id);
  assert.deepEqual(
    unenforced,
    [],
    `these decisions have no clause enforcing them and are not annotated ${JSON.stringify(STRUCTURAL)}: ${unenforced.join(', ')}`,
  );
});

test('the record is not shipped in the package', () => {
  const pkg = readJson('package.json');
  assert.ok(
    !pkg.files.includes(RECORD),
    `${RECORD} is a development record, not package payload; CL-D26 keeps it out of files`,
  );
});

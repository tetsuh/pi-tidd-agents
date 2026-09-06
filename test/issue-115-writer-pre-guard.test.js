'use strict';

// Issue #115 (CL-D64) — the exact-autofix writer runs the focused validation commands itself during
// the edit step and enters BEFORE_VALIDATION only when they pass; the guarded validation stays the
// single terminal check. A correction that targets a pinned literal receives that literal verbatim.
// Three PR #113 autofix runs ended BLOCKED on a one-shot assertion the writer never executed before
// the guard.
//
// TDD provenance: recorded with `node --test test/issue-115-writer-pre-guard.test.js` at RED before
// the prose, the record, and the manifest clauses existed. That local output is not claimed as
// repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, repoPath, sectionOf } = require('./helpers');

test('Issue #115 the writer iterates on focused validation before the guard and receives pinned literals verbatim', () => {
  const writer = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### The writer (CL-D3)');
  assert.ok(writer, 'the writer section must exist');
  assert.match(writer, /During the edit step, before `BEFORE_VALIDATION`, the writer runs the focused validation commands itself and proceeds to the guard only when they pass, using commands that leave no untracked artifact behind; the guarded focused validation stays the single terminal check, so the edit step is where the writer iterates\./);
  assert.match(writer, /When a correction targets a literal that a fixture or the clause manifest pins, the parent's instruction carries that literal verbatim from its source rather than describing it \(CL-D64\)\./);
  // The addendum is untouched: it sits inside its own byte guard and owns the guard sequence.
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.doesNotMatch(addendum, /the edit step is where the writer iterates/);
  assert.ok(Buffer.byteLength(addendum) < 28000, 'the CL-D30 addendum stays inside its recorded guard');
});

test('Issue #115 CL-D64 records the writer duty without relaxing the terminal rule', () => {
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D64 — The writer iterates on focused validation before the guard');
  assert.ok(record, 'CL-D64 must exist');
  for (const field of ['*Decision ID:* CL-D64', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D64 must carry ${field}`);
  assert.match(record, /issues\/115/);
  assert.match(record, /a retry after the guarded validation fails/);
  assert.match(record, /CL-D39's post-writer terminal rule is unchanged/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D64').map((clause) => clause.id).sort(), ['CL-D64-tests', 'CL-D64-writer']);
  assert.ok(fs.existsSync(repoPath('test/issue-115-writer-pre-guard.test.js')));
});

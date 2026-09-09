'use strict';

// Issue #119 (CL-D66) — when the adversarial gate rejects the rigor of a check (a presence, substring,
// or subsequence test where the criterion calls for an exact comparison), it names every check of the
// same class in that one result; the exact-autofix writer writes such checks as a complete parse plus
// an exact ordered comparison the first time. Six of PR #113's eight post-acceptance rounds were this
// class delivered one per round.
//
// TDD provenance: pre-implementation compile/contract RED (not behavioral RED: every assertion
// inspects artifact text), recorded with `node --test test/issue-119-exactness-class.test.js` at 0
// passes / 2 failures before the sentences, the record, and the manifest clauses existed. That local
// output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, repoPath, sectionOf } = require('./helpers');

test('Issue #119 the adversarial gate names every same-class rigor gap in one result and the writer writes exact checks', () => {
  const sol = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(sol, 'the Sol-only block must exist');
  assert.match(sol, /When a finding rejects the rigor of a check — a presence, substring, or subsequence test where the criterion calls for an exact comparison — name every check of the same class across the target in that one result, so the correction is made once \(CL-D66\)\./);
  const writer = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### The writer (CL-D3)');
  assert.ok(writer, 'the writer section must exist');
  assert.match(writer, /A check the writer adds or corrects against a declared list or block is written as a complete parse of the surface and an exact ordered comparison with the derived expectation, never as a presence, substring, or subsequence test \(CL-D66\)\./);
  // The addendum is untouched: it sits inside its own byte guard.
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.doesNotMatch(addendum, /CL-D66/);
  assert.ok(Buffer.byteLength(addendum) < 28000, 'the CL-D30 addendum stays inside its recorded guard');
});

test('Issue #119 CL-D66 records the placement, the declined alternatives, and the boundary', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D66 — Same-class rigor gaps are named once and written exactly the first time');
  assert.ok(record, 'CL-D66 must exist');
  for (const field of ['*Decision ID:* CL-D66', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D66 must carry ${field}`);
  assert.match(record, /issues\/119#issuecomment-5600016151/);
  assert.match(record, /a deterministic lint over test files, which classifies open-world test code and is declined/);
  assert.match(record, /a presence check where presence is the criterion is not a finding/);
  assert.match(record, /verdict vocabulary, gate authority, the CL-D30 caps, and the CL-D63 fence-grammar bound are unchanged/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D66').map((clause) => clause.id).sort(), ['CL-D66-payload', 'CL-D66-record', 'CL-D66-tests', 'CL-D66-writer']);
  assert.ok(fs.existsSync(repoPath('test/issue-119-exactness-class.test.js')));
});

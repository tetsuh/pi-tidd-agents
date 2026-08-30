'use strict';

// Issue #73 — the authority byte guards are set once, with headroom, and recorded.
//
// TDD provenance: before implementation the focused command below produced 1 pass and 2
// failures. The two failures are compile/contract RED against the unraised guards and the
// missing decision record. The live-measurement scenario passed at capture, because the files
// already sat inside the proposed guards; it earns its place going forward, by failing if a
// later change eats the headroom this issue exists to create. No behavioral RED is claimed:
// this issue changes recorded limits, not behavior.
// That local output is not claimed as repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { AUTHORITY_FILES, readText, repoPath, sectionOf } = require('./helpers');

const CONTRACT = readText('CONTRACT.md');
const PACKAGE_TEST = readText('test/package.test.js');
const CLEANLINESS_TEST = readText('test/pr-operational-cleanliness.test.js');

// The six authority files measured this at c2ad0db, when CL-D43 raised the ceiling to
// 128,000. It is a historical fact about that decision, not a running total.
const RAISE_BASELINE_BYTES = 114563;

test('Issue #73 the raised guards are the ones the suite actually asserts', () => {
  // The guards live in the suites that own them; this test pins the numbers so a silent
  // re-raise in either file fails here as well as there.
  assert.match(PACKAGE_TEST, /assert\.ok\(total < 128000,/);
  assert.equal(PACKAGE_TEST.includes('total < 116000'), false, 'the superseded six-file ceiling must not survive');
  assert.match(CLEANLINESS_TEST, /Buffer\.byteLength\(addendum\) < 28000,/);
  assert.equal(CLEANLINESS_TEST.includes('byteLength(addendum) < 25022'), false, 'the superseded addendum ceiling must not survive');

  // The disclosure guard is not a budget and is deliberately not raised.
  assert.match(PACKAGE_TEST, /const PR_SKILL_PRE_SPLIT_BYTES = 57160;/);
  assert.match(PACKAGE_TEST, /not a budget/);
});

test('Issue #73 the live measurements sit inside the raised guards', () => {
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 128000, `six authority files total ${total}`);
  // A raise that leaves no room would repeat the defect it is meant to remove — but that is a
  // fact about the raise, not about later growth. CL-D48: asserting it against the live total
  // made the margin a second, unstated ceiling that ordinary prose work had to negotiate with.
  // The measurement recorded when CL-D43 was taken cannot drift, so the property stays honest.
  assert.ok(128000 - RAISE_BASELINE_BYTES > 8000, `the raise left only ${128000 - RAISE_BASELINE_BYTES} bytes`);

  const addendum = sectionOf((readText('skills/closed-loop-pr/references/autofix.md') + '\n' + readText('skills/closed-loop-pr/references/autofix-addendum.md')), '## Exact PR `autofix` addendum (CL-D30)');
  assert.ok(addendum, 'the CL-D30 addendum must exist');
  assert.ok(Buffer.byteLength(addendum) < 28000, 'the addendum must sit inside its raised guard');

  // The exact-autofix prose absorbs each new decision. Before CL-D50 that was autofix.md;
  // after the split it is the addendum stage, and its growth signals when a further split —
  // not a raise — is the next structural answer.
  const addendumBytes = fs.statSync(repoPath('skills/closed-loop-pr/references/autofix-addendum.md')).size;
  const largest = AUTHORITY_FILES.map((file) => fs.statSync(repoPath(file)).size).sort((a, b) => b - a);
  assert.equal(addendumBytes === largest[0] || addendumBytes === largest[1], true, 'the addendum is expected to be among the two largest authority files');
});

test('Issue #73 CL-D43 records what the guards protect and when raising is wrong', () => {
  const decision = sectionOf(CONTRACT, '## CL-D43 — Authority byte guards are set once, with headroom');
  assert.ok(decision, 'CONTRACT.md must record CL-D43');
  for (const field of ['*Decision ID:* CL-D43', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D43 record must carry ${field}`);
  }
  assert.match(decision, /116,000 to 128,000/);
  assert.match(decision, /25,022 to 28,000/);
  assert.match(decision, /57,160 is not a budget/);
  assert.match(decision, /a raise decided inside a feature pull request/);
  assert.match(decision, /splitting `autofix\.md`/);
  // The disclosure guard, not the six-file ceiling, is what actually bounds autofix growth.
  assert.match(decision, /the effective room for `autofix\.md` prose/);
});

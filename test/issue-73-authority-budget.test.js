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

const { AUTHORITY_FILES, readText, readContract, repoPath, sectionOf } = require('./helpers');

const CONTRACT = readContract();
const PACKAGE_TEST = readText('test/package.test.js');

// The six authority files measured this at c2ad0db, when CL-D43 raised the ceiling to
// 128,000. It is a historical fact about that decision, not a running total.
const RAISE_BASELINE_BYTES = 114563;

test('Issue #73 the raised guards are the ones the suite actually asserts', () => {
  // The ceiling lives in the suite that owns it; this test pins the number so a silent re-raise there fails here as well.
  assert.match(PACKAGE_TEST, /assert\.ok\(total < 81000,/);
  assert.equal(PACKAGE_TEST.includes('total < 116000'), false, 'the superseded six-file ceiling must not survive');
  // #249 deleted the addendum and the mode references (CL-D119): the 32,000-byte addendum guard and the 57,160-byte
  // disclosure guard retired with them, and no suite still asserts either.
  for (const file of ['test/issue-115-writer-pre-guard.test.js', 'test/issue-119-exactness-class.test.js', 'test/issue-120-pr-body-template.test.js',
    'test/issue-126-sol-component-sweep.test.js', 'test/issue-153-wording-only-minors.test.js', 'test/pr-operational-cleanliness.test.js']) {
    assert.equal(/^\s*assert\.ok\(Buffer\.byteLength\(addendum\)[^\n]*< 32000/m.test(readText(file)), false, `${file} no longer asserts the retired addendum guard`);
  }
  assert.equal(PACKAGE_TEST.includes('PR_SKILL_PRE_SPLIT_BYTES'), false, 'the retired disclosure guard is gone');
});

test('Issue #73 the live measurements sit inside the raised guards', () => {
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 81000, `authority files total ${total}`);
  // A raise that leaves no room would repeat the defect it is meant to remove — but that is a
  // fact about the raise, not about later growth. CL-D48: asserting it against the live total
  // made the margin a second, unstated ceiling that ordinary prose work had to negotiate with.
  // The measurement recorded when CL-D43 was taken cannot drift, so the property stays honest.
  assert.ok(128000 - RAISE_BASELINE_BYTES > 8000, `the raise left only ${128000 - RAISE_BASELINE_BYTES} bytes`);
  // #249 deleted the addendum and the map (CL-D119), and the rules that ranked them retired with them.
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
  // CL-D43's record of why the disclosure guard bounded autofix growth then; #249 retired it with the file (CL-D119).
  assert.match(decision, /the effective room for `autofix\.md` prose/);
});

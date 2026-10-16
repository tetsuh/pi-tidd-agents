'use strict';

// Issue #87 (CL-D50) — the CL-D30 addendum moved from a section of `autofix.md` into its own
// third disclosure stage (#249 later deleted the mode reference and the addendum, CL-D119): Skill,
// then the selected mode reference, then — only when the exact `autofix` token selected the mode —
// the addendum file the reference directs to. The mode
// invariant is untouched: exactly one mode reference is read, and the addendum is not a mode
// reference; it is selected by one.
//
// TDD provenance: recorded with the focused command below at 0 passes. Every failure is
// compile/contract RED against the unsplit layout. No behavioral RED is claimed: no prose is
// reworded — this issue relocates it and re-scopes the guards that bound it.

const test = require('node:test');
const assert = require('node:assert/strict');
// #249 C2 (CL-D119) deleted the addendum and the base reference; only the record test remains.
const { readContract, sectionOf } = require('./helpers');

test('Issue #87 CL-D50 records the third disclosure stage', () => {
  const decision = sectionOf(readContract(), '## CL-D50 — The CL-D30 addendum is a third disclosure stage');
  assert.ok(decision, 'CONTRACT.md must record CL-D50');
  for (const field of ['*Decision ID:* CL-D50', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D50 must carry ${field}`);
  }
  assert.match(decision, /the addendum is not a mode reference; it is selected by one/);
  assert.match(decision, /no prose is reworded/);
  assert.match(decision, /The aggregate set becomes seven files with its total and ceiling unchanged/);
});

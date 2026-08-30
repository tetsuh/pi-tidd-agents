'use strict';

// Issue #96, rule 2 (CL-D55) — a guard failure in Luna's batch sequence must name the violated
// condition and the observed value. A bare nonzero exit with no output is not evidence that a
// boundary was violated; it is a guard-implementation defect, reported as exactly that, and
// still terminal. Corollary of "a check that cannot fail is not a check": a failure that
// cannot be named is not a finding.
//
// TDD provenance: recorded with the focused command below at 0 passes, all compile/contract
// RED against the unamended addendum and the missing record. No behavioral RED is claimed:
// this rule changes what a failure report must contain, not what any operation does; the
// packaged-guard operations are Issue #96 rule 1 and are not part of this change.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';

test('Issue #96 every batch-sequence guard failure names its violated condition', () => {
  const text = readText(ADDENDUM);
  assert.match(text, /naming the violated condition and the observed value — the specific subcheck, not the guard as a whole/);
  assert.match(text, /A guard failure with no named condition, such as a bare nonzero exit with no output, is not evidence that a boundary was violated/);
  assert.match(text, /it is a guard-implementation defect/);
  // The rule must not weaken CL-D39: both true failures and implementation-defect stops stay
  // terminal after editing begins.
  assert.match(text, /a true failure after editing begins remains terminal with no retry and no guard substitution \(CL-D39\), and an implementation-defect stop is terminal the same way/);
});

test('Issue #96 CL-D55 records the naming duty and what it deliberately does not change', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D55 — A guard failure must name its failed subcheck');
  assert.ok(decision, 'CONTRACT.md must record CL-D55');
  for (const field of ['*Decision ID:* CL-D55', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D55 must carry ${field}`);
  }
  assert.match(decision, /empty stdout and stderr/);
  assert.match(decision, /a failure that cannot be named is not a finding/);
  assert.match(decision, /terminality is unchanged/);
  assert.match(decision, /packaged guard operations remain a separate decision/);
});

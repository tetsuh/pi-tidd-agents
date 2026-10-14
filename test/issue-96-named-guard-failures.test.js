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

const { readText, readContract, sectionOf } = require('./helpers');

test('Issue #96 every batch-sequence guard failure names its violated condition', () => {
  // #249 B4b (CL-D117): the naming duty is read in the packaged guards, which throw every refusal with its subcheck and
  // observed value and name a raw process failure, and in the record.
  const guards = readText('skills/closed-loop-pr/helpers/guards.js');
  assert.ok(guards.includes("throw Object.assign(new Error(`${subcheck}: ${message}`), { code, details: { subcheck, observed: observed === undefined ? message : observed } });"), 'a refusal names its subcheck and the observed value');
  assert.ok(guards.includes(": { subcheck: 'process_failure', observed: error.message };"), 'a raw process failure is named too');
  const record = readText('contract/CL-D55.md');
  assert.match(record, /a failure with no named condition is a guard-implementation defect and its report says so/);
  // The rule must not weaken CL-D39: both true failures and implementation-defect stops stay terminal after editing begins.
  assert.match(record, /Terminality is unchanged: a true post-edit failure stays terminal with no retry or guard substitution, and an implementation-defect stop is terminal the same way\./);
});

test('Issue #96 CL-D55 records the naming duty and what it deliberately does not change', () => {
  const decision = sectionOf(readContract(), '## CL-D55 — A guard failure must name its failed subcheck');
  assert.ok(decision, 'CONTRACT.md must record CL-D55');
  for (const field of ['*Decision ID:* CL-D55', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D55 must carry ${field}`);
  }
  assert.match(decision, /empty stdout and stderr/);
  assert.match(decision, /a failure that cannot be named is not a finding/);
  assert.match(decision, /Terminality is unchanged/);
  assert.match(decision, /packaged guard operations remain a separate decision/);
});

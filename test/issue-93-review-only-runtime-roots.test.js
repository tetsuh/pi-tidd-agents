'use strict';

// Issue #93 (CL-D54) — review-only tolerates pre-existing untracked paths under the harness's
// own runtime roots, the same two roots exact autofix already names and the packaged helpers
// already filter. Everything else keeps failing closed.
//
// TDD provenance: recorded with the focused command below at 0 passes. Every failure is
// compile/contract RED against the unamended prose, manifest, and missing record. No
// behavioral RED is claimed: the packaged helpers already tolerate runtime roots
// (`operator.js` filters them out of `unexpectedUntrackedPaths`); the run-killing rule lived
// in review-only prose alone, and prose is what changes.
//
// #249 B2 (CL-D113): since CL-D111 the review-only run is the packaged driver, so the carve-out is read from
// `driver/run.js` and the record; the drift fixture compares the driver's root set with the helpers' and, until
// its own pull request, with `references/autofix.md`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readContract, sectionOf } = require('./helpers');

const REVIEW_DRIVER = 'skills/closed-loop-pr/driver/run.js';
const AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const ROOTS_LITERAL = '`RUNTIME_ROOTS := { ".pi", ".pi-subagents" }`';
const DRIVER_ROOTS = "const RUNTIME_ROOTS = ['.pi', '.pi-subagents'];";

test('Issue #93 the review-only driver names the runtime-root carve-out and keeps everything else closed', () => {
  const text = readText(REVIEW_DRIVER);
  assert.ok(text.includes(DRIVER_ROOTS), 'the carve-out names the exact root set');
  assert.match(text, /A runtime root may hold untracked files only while it is absent or a real directory, judged without following a/);
  assert.match(text, /if \(code === '\?\?' && underRoot\) continue;/, 'untracked paths beneath a root are tolerated');
  assert.match(text, /return `the runtime root \$\{root\} is not a directory`;/, 'an unsafe root stops');
  assert.match(text, /the checkout is not clean:/, 'everything else keeps failing closed');
  const record = readText('contract/CL-D54.md');
  assert.match(record, /their bytes enter no fingerprint, gate payload, draft, or evidence claim, and the run never claims they were cleaned, preserved, or validated/);
  assert.match(record, /untracked paths outside `RUNTIME_ROOTS` and the frozen `VALIDATION_SANDBOX_DELTA` keep failing closed/);
});

test('Issue #93 the review-only driver stops BLOCKED on a change outside the roots, after validation and before every gate', () => {
  const review = readText('skills/closed-loop-pr/driver/review.js');
  assert.match(review, /run\.stop\('BLOCKED', `validation changed the checkout: \$\{after\}`\)/);
  assert.ok(review.includes("const checkout = checkoutProblem(s.checkout, t.headOid); if (checkout) run.stop('BLOCKED', checkout);"), 'revalidate stops before every gate');
  assert.ok(review.includes("if (drift.length) run.stop('BLOCKED', `the checkout's ignored paths changed after validation:"), 'and on an ignored-path drift');
});

test('Issue #93 the driver, the autofix reference and the helpers agree on the root set', () => {
  // The driver declares its own copy rather than importing the helpers'; divergence is prevented here, mechanically.
  assert.ok(readText(REVIEW_DRIVER).includes(DRIVER_ROOTS), `${REVIEW_DRIVER} must state the identical root set`);
  assert.ok(readText(AUTOFIX).includes(ROOTS_LITERAL), `${AUTOFIX} must state the identical root set`);
  const { RUNTIME_ROOTS } = require('../skills/closed-loop-pr/helpers/operator');
  assert.deepEqual(RUNTIME_ROOTS, ['.pi', '.pi-subagents'], 'the packaged tolerance must cover the same roots the driver names');
});

test('Issue #93 CL-D54 records the carve-out and what it amends', () => {
  const decision = sectionOf(readContract(), '## CL-D54 — Review-only tolerates the runtime roots the harness itself writes');
  assert.ok(decision, 'CONTRACT.md must record CL-D54');
  for (const field of ['*Decision ID:* CL-D54', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D54 must carry ${field}`);
  }
  assert.match(decision, /amends the CL-D38-review-only boundary sentence/);
  assert.match(decision, /the harness blocked on its own task directories/);
  assert.match(decision, /no cleanup, deletion, or relocation authority/);
  assert.match(decision, /If the two mode references ever name different root sets/);
  assert.match(decision, /#249 later moved this record's pins to `driver\/run\.js` \(CL-D113\)/);
});

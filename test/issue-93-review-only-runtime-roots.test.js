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

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const ROOTS_LITERAL = '`RUNTIME_ROOTS := { ".pi", ".pi-subagents" }`';

test('Issue #93 review-only names the runtime-root carve-out and keeps everything else closed', () => {
  const text = readText(REVIEW_ONLY);
  const section = sectionOf(text, '### Runtime roots (CL-D54)');
  assert.ok(section, `${REVIEW_ONLY} must own a runtime-roots subsection`);
  assert.ok(section.includes(ROOTS_LITERAL), 'the carve-out names the exact root set');
  assert.match(section, /classify each independently and no-follow as absent or a real directory/);
  assert.match(section, /read no contents, targets, sizes, timestamps, or hashes/);
  assert.match(section, /tolerate pre-existing untracked paths beneath them/);
  assert.match(section, /contribute nothing to any fingerprint, gate payload, draft, or evidence claim/);
  assert.match(section, /never claims they were cleaned, preserved, or validated/);
  assert.match(section, /untracked paths outside `RUNTIME_ROOTS` and the frozen `VALIDATION_SANDBOX_DELTA` still stop as `BLOCKED`/);
});

test('Issue #93 the amended CL-D38 boundary sentence carries the qualification once', () => {
  const text = readText(REVIEW_ONLY);
  assert.match(text, /any tracked change, index change, ref movement, unsafe root, or non-validation untracked path outside `RUNTIME_ROOTS` still stops the run as `BLOCKED`/);
  assert.doesNotMatch(text, /untracked path still stops the run/, 'the unqualified sentence must not survive beside its replacement');
});

test('Issue #93 both mode references and the helpers agree on the root set', () => {
  // The definition is deliberately stated in both mode references: each mode is read with the
  // Skill alone, so neither can cite the other. Divergence is prevented here, mechanically.
  for (const file of [REVIEW_ONLY, AUTOFIX]) {
    assert.ok(readText(file).includes(ROOTS_LITERAL), `${file} must state the identical root set`);
  }
  const { RUNTIME_ROOTS } = require('../skills/closed-loop-pr/helpers/operator');
  assert.deepEqual(RUNTIME_ROOTS, ['.pi', '.pi-subagents'], 'the packaged tolerance must cover the same roots the prose names');
});

test('Issue #93 CL-D54 records the carve-out and what it amends', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D54 — Review-only tolerates the runtime roots the harness itself writes');
  assert.ok(decision, 'CONTRACT.md must record CL-D54');
  for (const field of ['*Decision ID:* CL-D54', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D54 must carry ${field}`);
  }
  assert.match(decision, /amends the CL-D38-review-only boundary sentence/);
  assert.match(decision, /the harness blocked on its own task directories/);
  assert.match(decision, /no cleanup, deletion, or relocation authority/);
  assert.match(decision, /If the two mode references ever name different root sets/);
});

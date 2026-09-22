'use strict';

// Issue #153 (CL-D85) — three rules the owner decided on 2026-09-20 after PR #147 took six rounds to reach
// MERGE_READY and rounds 2 to 6 changed only prose: a Minor whose correction changes no file of the head does
// not stop the run; the chronology leaves the pull-request body, so a round no longer edits it; and a repeat of
// a settled counterexample class is recorded as the earlier round's review miss.
//
// TDD provenance: pre-implementation compile/contract RED (not behavioural: every assertion inspects artifact
// text), recorded with `node --test test/issue-153-wording-only-minors.test.js` before the rules, the record,
// the manifest clauses, and the guard reset existed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, repoPath, sectionOf, AUTHORITY_FILES } = require('./helpers');

const ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';

test('Issue #153 rule 1: a Minor that changes no file of the head is recorded, not blocking', () => {
  const classes = sectionOf(readText('skills/closed-loop-shared/references/records.md'), '## Finding anchoring classes (AC-ANCHOR, CL-D34)');
  assert.ok(classes, 'the anchoring classes section must exist');
  assert.match(classes, /A Minor whose correction changes no file of the head — a target-body edit, or a wording change that alters no obligation — is recorded with its anchoring class and its disposition and does not stop the run, and readiness may be reported with such Minors recorded\./);
  assert.match(classes, /A finding that corrects a false safety claim changes what the contract promises, so it is not wording only and keeps its severity \(CL-D85\)\./);
  const readiness = sectionOf(readText(ADDENDUM), '### Source-finding replies and final readiness');
  assert.ok(readiness, 'the readiness section must exist');
  assert.match(readiness, /every finding has final disposition, a Minor whose correction changes no file of the head counting as dispositioned once recorded \(CL-D85\)/);
});

test('Issue #153 rule 2: the chronology leaves the pull-request body', () => {
  const template = sectionOf(readText('skills/closed-loop-pr/SKILL.md'), '### PR body template (CL-D67)');
  assert.ok(template, 'the PR body template subsection must exist');
  assert.match(template, /A pull-request body under this workflow carries three parts and nothing else: a `Closes #<n>` line with the owner-decision link; a Scope paragraph that points to the contract record, the manifest clauses, and the files that carry the change and states that the body does not restate them; and the AC-TDD classification of the RED with its command and counts, followed at most by one tooling attribution footer\./);
  assert.match(template, /the chronology of review rounds lives on the target's timeline, so a round edits no body and invalidates no snapshot by doing so \(CL-D67, CL-D85\)\./);
  assert.doesNotMatch(template, /the chronology is appended after each review round/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pinned = manifest.clauses.find((clause) => clause.id === 'CL-D67-template');
  assert.ok(pinned.requires.some((sentence) => sentence.includes('carries three parts and nothing else')), 'the manifest pins the three-part body');
  assert.ok(!pinned.requires.some((sentence) => sentence.includes('carries four parts')), 'the superseded four-part sentence must not survive in the manifest');
});

test('Issue #153 rule 3: a repeat of a settled class is recorded as the earlier round\'s miss', () => {
  const findings = sectionOf(readText(ADDENDUM), '### Findings, no-progress, and deterministic status');
  assert.ok(findings, 'the findings section must exist');
  assert.match(findings, /When a gate raises a finding of the same counterexample class as one the settled ledger already carries for an earlier head of this pull request, the run also records it in the status block as a review miss of the round that did not raise it \(CL-D85\)\./);
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /^review_misses: <finding class: the round that did not raise it, one per line, or none>$/m);
  assert.match(reviewOnly, /A Minor whose correction changes no file of the head is recorded with its disposition and never blocks `MERGE_READY` \(CL-D85\)\./);
});

test('Issue #153 CL-D85 records the three rules and the addendum guard reset', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D85 — Wording-only Minors do not stop a run');
  assert.ok(record, 'CL-D85 must exist');
  for (const field of ['*Decision ID:* CL-D85', '*Kind:* contract', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D85 must carry ${field}`);
  }
  assert.match(record, /issues\/153#issuecomment-5777454006/, 'the record cites the owner choice on the guard reset');
  assert.match(record, /The addendum's recorded guard resets from 29,000 to 30,000 bytes for the three rules recorded here, on the CL-D37 terms CL-D74 used: no prose was trimmed to make room, the figure is revision-qualified, and both helper alarms are untouched\./);
  // The records CL-D85 amends say so themselves.
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model') || '', /CL-D85/);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D67 — Pull-request bodies carry no per-head facts') || '', /CL-D85/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D85').map((clause) => clause.id).sort(),
    ['CL-D85-classes', 'CL-D85-misses', 'CL-D85-readiness', 'CL-D85-record', 'CL-D85-status', 'CL-D85-tests']);
  assert.ok(fs.existsSync(repoPath('test/issue-153-wording-only-minors.test.js')));
});

test('Issue #153 the reset guard is the one every suite asserts', () => {
  const addendum = readText(ADDENDUM);
  assert.ok(Buffer.byteLength(addendum) < 30000, `the CL-D30 addendum stays inside its reset guard: ${Buffer.byteLength(addendum)}`);
  for (const file of fs.readdirSync(repoPath('test'))) {
    if (!file.endsWith('.test.js')) continue;
    assert.equal(readText(`test/${file}`).includes('< 29000'), false, `${file} must not keep the superseded addendum guard`);
  }
  const carriers = ['test/issue-115-writer-pre-guard.test.js', 'test/issue-119-exactness-class.test.js', 'test/issue-120-pr-body-template.test.js', 'test/issue-126-sol-component-sweep.test.js'];
  for (const file of carriers) assert.match(readText(file), /< 30000/, `${file} asserts the reset guard`);
  // The aggregate ceiling is untouched by this issue and still holds.
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + Buffer.byteLength(readText(file)), 0);
  assert.ok(total < 150000, `authority files total ${total}`);
});

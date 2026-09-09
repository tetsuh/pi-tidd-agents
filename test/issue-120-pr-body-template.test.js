'use strict';

// Issue #120 (CL-D67) — a pull-request body under this workflow carries no per-head facts: a Closes
// line, a Scope pointer, the AC-TDD classification, and a chronology. Per-head measurements live in
// commit messages and in the review's published comment, so no body claim depends on the head; the
// chronology is appended after each review round. Exact autofix therefore has no body-only finding
// to stop on. Three PR #113 rounds were body drift.
//
// TDD provenance: pre-implementation compile/contract RED (not behavioral RED: every assertion
// inspects artifact text), recorded with `node --test test/issue-120-pr-body-template.test.js` at 0
// passes / 2 failures before the template, the record, and the manifest clauses existed. That local
// output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, repoPath, sectionOf } = require('./helpers');

test('Issue #120 the PR Skill states the body template and keeps per-head facts out of the body', () => {
  const template = sectionOf(readText('skills/closed-loop-pr/SKILL.md'), '### PR body template (CL-D67)');
  assert.ok(template, 'the PR body template subsection must exist');
  assert.match(template, /A pull-request body under this workflow carries four parts and nothing else: a `Closes #<n>` line with the owner-decision link; a Scope paragraph that points to the contract record, the manifest clauses, and the files that carry the change and states that the body does not restate them; the AC-TDD classification of the RED with its command and counts; and a chronology of review rounds, followed at most by one tooling attribution footer\./);
  assert.match(template, /Per-head measurements — run counts, guard bytes, authority headroom — live in commit messages and in the review's published comment, never in the body, so no body claim depends on the head; the chronology is appended after each review round \(CL-D67\)\./);
  // The exact-autofix grant is unchanged: the addendum does not mention a body edit.
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.doesNotMatch(addendum, /CL-D67|PATCH the body|pull-request body edit/);
  assert.ok(Buffer.byteLength(addendum) < 28000, 'the CL-D30 addendum stays inside its recorded guard');
});

test('Issue #120 CL-D67 records the choice, the declined bounded body edit, and the boundary', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D67 — Pull-request bodies carry no per-head facts');
  assert.ok(record, 'CL-D67 must exist');
  for (const field of ['*Decision ID:* CL-D67', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D67 must carry ${field}`);
  // CONV-122-CONTRACT-CITATION-002: both cited comments are pinned by id; the design comment was once miscited.
  assert.match(record, /issues\/120#issuecomment-5600017960/);
  assert.match(record, /issues\/120#issuecomment-5602812931/);
  assert.match(record, /Option A adds one bounded pull-request body edit to the exact-autofix grant/);
  assert.match(record, /the exact-autofix publication grant is unchanged: one commit and one push per correction batch, no body edit/);
  assert.match(record, /Adding a body edit to the grant requires a new owner decision/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D67').map((clause) => clause.id).sort(), ['CL-D67-record', 'CL-D67-template', 'CL-D67-tests']);
  assert.ok(fs.existsSync(repoPath('test/issue-120-pr-body-template.test.js')));
});

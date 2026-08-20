'use strict';

// Issue #61 / CL-D38: review-only runs validation in the operator checkout, and validation
// toolchains write ignored caches (`__pycache__`, `.pytest_cache`, build caches). Exact
// autofix already treats those as a frozen run-owned delta; review-only aborted on them, so
// the strictest cleanliness rule sat on the mode that mutates nothing. Compile/contract
// coverage over the shipped prose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson } = require('./helpers');

const PR_SKILL = 'skills/closed-loop-pr/SKILL.md';
const PR_REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const CONTRACT = 'CONTRACT.md';

function sectionOf(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(#+)\s/);
    if (match && match[1].length <= depth) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('Issue #61 the PR root defines the validation sandbox delta once for both modes', () => {
  // Both PR modes load the root plus their mode reference, so the definition belongs to the
  // root. Putting it in the shared gate contract would impose a PR-only concept on the Issue
  // root, and restating it per mode would reintroduce the duplication Issue #58 removed.
  const section = sectionOf(readText(PR_SKILL), '### Validation sandbox delta (CL-D38)');
  assert.ok(section, `${PR_SKILL} must own the validation sandbox delta definition`);
  assert.match(section, /`VALIDATION_SANDBOX_DELTA` :=/);
  assert.match(section, /ignored paths that this run's own validation created/);
  assert.match(section, /frozen by path, type, and no-follow presence/);
  assert.match(section, /never read, followed, deleted, pruned, or restored/);
  assert.match(section, /never enters evidence, a fingerprint, a draft, or a status block/);
  // The definition must not be restated in either mode reference.
  for (const file of [PR_REVIEW_ONLY, PR_AUTOFIX]) {
    assert.doesNotMatch(readText(file), /`VALIDATION_SANDBOX_DELTA` :=/, `${file} must reference the root definition, not restate it`);
  }
});

test('Issue #61 review-only permits only the validation delta and keeps every other prohibition', () => {
  const text = readText(PR_REVIEW_ONLY);
  const section = sectionOf(text, '### Validation sandbox boundary (CL-D38)');
  assert.ok(section, `${PR_REVIEW_ONLY} must state its validation sandbox boundary`);
  assert.match(section, /`VALIDATION_SANDBOX_DELTA`/);
  assert.match(section, /Every later boundary permits only that exact presence delta/);
  assert.match(section, /any tracked change, index change, ref movement, unsafe root, or non-validation untracked path/);
  assert.match(section, /`BLOCKED`/, 'a safety stop must be BLOCKED, not a tool failure');
  assert.match(section, /grants no cleanup, publication, commit, push, or reply authority/);

  // The prohibition list survives, including the literal AC-REVIEW-ONLY-skill pins.
  const prohibitions = sectionOf(text, '## Review-only is the default (AC-REVIEW-ONLY, CL-D15)');
  for (const line of [
    'do not edit any file in the repository',
    'do not change git state',
    'do not commit or push',
    'do not post to GitHub',
    'do not reply to review threads',
    'do not mutate any external service',
  ]) assert.ok(prohibitions.includes(line), `review-only lost the prohibition: ${line}`);
  // The blanket wording must acknowledge the single carve-out rather than contradict it.
  assert.match(prohibitions, /apart from `VALIDATION_SANDBOX_DELTA`/);
});

test('Issue #61 exact autofix keeps its phase usage and stops redefining the delta', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /`VALIDATION_SANDBOX_DELTA`/, 'autofix must still name the delta at its phases');
  assert.match(text, /AFTER_VALIDATION/);
  // The general definition moved to the root; the mode reference keeps only its phase rules.
  assert.doesNotMatch(text, /Validation-created ignored caches are frozen run-owned sandbox state/, 'the definition must not remain duplicated in the mode reference');
});

test('Issue #61 CONTRACT.md records CL-D38 with clause ownership', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D38 — Review-only tolerates the validation sandbox delta it created');
  assert.ok(section, 'CL-D38 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D38-definition, CL-D38-review-only$/m);
  assert.match(section, /^\*Decision ID:\* CL-D38$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#61/);
  assert.match(section, /review-only mutates nothing yet aborted on a cache exact autofix already permits/);
  assert.match(section, /no cleanup, publication, commit, push, reply, or provider authority/);
  // The measured fact that drove the design: an environment convention cannot be the rule.
  assert.match(section, /PYTHONDONTWRITEBYTECODE/);
  assert.match(section, /operator environment convention is not the mechanism/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D38').map((clause) => clause.id).sort(),
    ['CL-D38-definition', 'CL-D38-review-only'],
  );
});

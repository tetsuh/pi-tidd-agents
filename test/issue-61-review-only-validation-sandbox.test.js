'use strict';

// Issue #61 / CL-D38: review-only runs validation in the operator checkout, and validation
// toolchains write ignored caches (`__pycache__`, `.pytest_cache`, build caches). Exact
// autofix already treats those as a frozen run-owned delta; review-only aborted on them, so
// the strictest cleanliness rule sat on the mode that mutates nothing. Compile/contract
// coverage over the shipped prose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readContract, sectionOf, readManifest } = require('./helpers');

const PR_SKILL = 'skills/closed-loop-pr/SKILL.md';
const PR_REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const PR_AUTOFIX_ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';


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
  // The definition must not be restated in either mode reference or in the addendum stage.
  for (const file of [PR_REVIEW_ONLY, PR_AUTOFIX, PR_AUTOFIX_ADDENDUM]) {
    assert.doesNotMatch(readText(file), /`VALIDATION_SANDBOX_DELTA` :=/, `${file} must reference the root definition, not restate it`);
  }
});

test('Issue #61 review-only permits only the validation delta and keeps every other prohibition', () => {
  // #249 B2 (CL-D113): the review-only driver freezes the ignored inventory once validation ran and compares it before
  // every gate; any other change to the checkout stops BLOCKED.
  const review = readText('skills/closed-loop-pr/driver/review.js');
  const run = readText('skills/closed-loop-pr/driver/run.js');
  assert.ok(review.includes('s.ignoredDelta = ignoredInventory(checkout); run.save();'), 'the delta is frozen after validation');
  assert.ok(review.includes("the checkout's ignored paths changed after validation:"), 'a later boundary permits only that delta');
  assert.ok(run.includes('the checkout is not clean:'), 'a tracked, index or untracked change stops');
  assert.ok(run.includes('return local === headOid ? dirtyCheckout(cwd) : `the checkout is at ${local}, not the public head ${headOid}`;'), 'ref movement stops');
  assert.ok(run.includes('return `the runtime root ${root} is not a directory`;'), 'an unsafe root stops');
  assert.ok(review.includes("run.stop('BLOCKED', `validation changed the checkout: ${after}`)"), 'a safety stop is BLOCKED, not a tool failure');
  assert.match(readText('contract/CL-D38.md'), /It grants no cleanup, publication, commit, push, reply, or provider authority/);

  // The prohibition list survives in the record, with the driver naming no writing operation.
  const record = readText('contract/AC-REVIEW-ONLY.md');
  assert.match(record, /no file edits, no git-state changes, no commits or pushes, no posting to GitHub, no replies to review threads, and no external mutation/);
  assert.match(record, /the packaged review-only driver names no writing operation/);
});

test('Issue #61 exact autofix keeps its phase usage and stops redefining the delta', () => {
  const text = (readText(PR_AUTOFIX) + '\n' + readText(PR_AUTOFIX_ADDENDUM));
  assert.match(text, /`VALIDATION_SANDBOX_DELTA`/, 'autofix must still name the delta at its phases');
  // #249 B4a (CL-D115): the phase guard is read in the driver's batch chain.
  assert.ok(readText('skills/closed-loop-pr/driver/autofix.js').includes("step('overlay_compare', { cwd: ws, overlay }); // AFTER_VALIDATION"));
  // The general definition moved to the root; the mode reference keeps only its phase rules.
  assert.doesNotMatch(text, /Validation-created ignored caches are frozen run-owned sandbox state/, 'the definition must not remain duplicated in the mode reference');
});

test('Issue #61 CONTRACT.md records CL-D38 with clause ownership', () => {
  const section = sectionOf(readContract(), '## CL-D38 — Review-only tolerates the validation sandbox delta it created');
  assert.ok(section, 'CL-D38 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D38-definition, CL-D38-review-only, CL-D38-review-only-freeze, CL-D38-review-only-record$/m); // #249 B2 (CL-D113)
  assert.match(section, /^\*Decision ID:\* CL-D38$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#61/);
  assert.match(section, /review-only mutates nothing yet aborted on a cache exact autofix already permits/);
  assert.match(section, /no cleanup, publication, commit, push, reply, or provider authority/);
  // The measured fact that drove the design: an environment convention cannot be the rule.
  assert.match(section, /PYTHONDONTWRITEBYTECODE/);
  assert.match(section, /operator environment convention is not the mechanism/);

  const manifest = readManifest();
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D38').map((clause) => clause.id).sort(),
    ['CL-D38-definition', 'CL-D38-review-only', 'CL-D38-review-only-freeze', 'CL-D38-review-only-record'],
  );
});

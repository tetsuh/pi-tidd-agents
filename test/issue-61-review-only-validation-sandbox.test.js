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


test('Issue #61 the drivers freeze the validation sandbox delta, and CL-D38 records how it is observed', () => {
  // #249 C2 (CL-D119) trimmed the PR Skill's definition; the drivers' code and CL-D38 carry the rule and its divergence.
  const phases = readText('skills/closed-loop-pr/driver/phases.js');
  assert.ok(phases.includes('// Ignored paths a validation, a gate, or a writer changed since the run took them (CL-D38): a list'));
  assert.ok(phases.includes('const now = ignoredInventory(cwd), drift = [...now.filter((x) => !saved.includes(x)), ...saved.filter((x) => !now.includes(x))];'));
  assert.match(readText('contract/CL-D38.md'), /that inventory hashes each ignored file's content and a stop names the changed entries, where the definition observed presence only, recorded and not closed \(#249, CL-D119\)\./);
  // The definition's rules stand in the record, beside the divergence it records.
  const d38 = readText('contract/CL-D38.md');
  assert.match(d38, /never read, followed, deleted, pruned, or restored/);
  assert.match(d38, /never enters evidence, a fingerprint, a draft, or a status block/);
  assert.equal(readText(PR_SKILL).includes('`VALIDATION_SANDBOX_DELTA` :='), false, 'the PR Skill no longer defines it');
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

test('Issue #61 exact autofix keeps its phase guard in the driver', () => {
  // #249 B4a (CL-D115): the phase guard is read in the driver's batch chain.
  assert.ok(readText('skills/closed-loop-pr/driver/autofix.js').includes("step('overlay_compare', { cwd: ws, overlay }); // AFTER_VALIDATION"));
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

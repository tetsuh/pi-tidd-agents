'use strict';

// Issue #277 (#249 B3, CL-D114): since CL-D111 no run reads `references/autofix.md` as guidance (driver/autofix.js still
// hashes it into contractInput), and the last pull request of #249 deletes it. Before that, every clause pin and every
// rule-stating test read moves off the file to where the rule lives now: the driver or helper code that implements the
// rule where the file carries the record's marker (CL-D10, CL-D30 and CL-D39 in driver comments that cited the file,
// CL-D25 and CL-D30 in helper comments), else the record's own sentence. The file itself and the driver byte alarms are
// unchanged, so the pull request is behaviour-neutral.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readText, readContract, manifestSources, sectionOf } = require('./helpers');

const FILE = 'skills/closed-loop-pr/references/autofix.md';
// The rule-stating reads (AC2) leave the file entirely, directly and through readAutofixProcedure.
// #249 C1 (CL-D118) retired issue-35's last read, the map's no-shell instruction.
const RULE_TESTS = ['issue-100-tidd-roles', 'issue-114-message-verify', 'issue-115-writer-pre-guard', 'issue-119-exactness-class', 'issue-169-post-push-revalidation', 'issue-38-recovery-transition', 'issue-69-worktree-recovery', 'issue-80-cleanup-terminal', 'issue-82-zero-output-relaunch', 'issue-93-review-only-runtime-roots', 'issue-35-failure-injection'];
// A file holding both kinds keeps only its structural reads: each named here, beside the rule-stating read it lost.
const MIXED_TESTS = {
  'closed-loop-regressions': {
    keep: ["const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';", 'assert.equal((skill.match(/^- `REPLY_EXCEPTION` :=/gm) || []).length, 1);'],
    gone: ['assert.match(skill, /five successful correction pushes/);', 'for (const text of autofixOwned) assert.ok(autofix.includes(text)', 'assert.match(writer, /sole correction writer and publisher/);', "'head branch to be verified writable by a normal actor-authorized non-force push', 'The parent Luna payload contains',"],
  },
  package: {
    keep: ["autofix: 'skills/closed-loop-pr/references/autofix.md',", 'assert.match(autofix, /## Autofix \\(AC-AUTOFIX,/);', 'assert.match(autofix, /The exact `autofix` token additionally selects the CL-D30 addendum'],
    gone: ['for (const text of autofixExclusive) assert.ok(autofixStage.includes(text)'],
  },
  'pr-operational-cleanliness': {
    keep: ['const PR_AUTOFIX = readAutofixProcedure();', 'assert.equal(definitionCount(SKILL, name), 1, `${name} must be defined exactly once in the PR Skill`);', "assert.equal((SKILL.match(definition) || []).length, 1, 'PR Skill must define RUNTIME_ROOTS exactly once');"],
    gone: ["section(SKILL, '### Isolated exact-autofix invariants (CL-D10, CL-D30)')", "section(SKILL, '### Worktree precondition (CL-D10)')"],
  },
  'issue-34-bounded-recovery': {
    keep: ["assert.ok(text.indexOf('### Bounded pre-writer recovery (CL-D39)') < text.indexOf('except for the CL-D39 recovery defined above'));"],
    gone: ['function mappingOutcomes() {', "assert.match(section, /One recovery is permitted for either a deterministic local tooling failure"],
  },
  // These two kept a read through the retired readAutofixProcedure for the helper map's text until #249 deleted the map
  // (CL-D119); each keep line names that read, now gone.
  'issue-36-evidence-envelope': {
    keep: ["const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');"],
    gone: ["sectionOf(AUTOFIX, '### Versioned evidence envelope (CL-D42)')"],
  },
  'issue-64-validation-run': {
    keep: ["const map = sectionOf(autofix, '### Packaged helper invocation map (CL-D30, Issue #47)');"],
    gone: ["autofix.includes('| validation harness could not run", "autofix.includes('The guarded focused validation runs through packaged `validation_run` (CL-D72).')"],
  },
  'issue-164-map-split': {
    keep: ["assert.equal(autofix.includes('| Phase | Operation | Required data |'), false, 'the table is not in two places');"],
    gone: ["'one pointer'"],
  },
  'issue-candidate-publication': {
    keep: ["assert.doesNotMatch(pr, /Issue PATCH.*POST.*CL-D30/s);"],
    gone: ['assert.match(pr, /CL-D31 exception/);'],
  },
};
// The structural reads (existence, headings, the split, duplication guards, authority measurement, derived vocabulary
// surfaces, contractInput) went with the file (#249, CL-D119).
// #249 B4b (CL-D117) moved issue-51's remaining reads to CL-D34 and the builder.
const STILL_KEPT = new Set(['assert.doesNotMatch(pr, /Issue PATCH.*POST.*CL-D30/s);']);
const RETIRED = ['CL-D107-autofix', 'CL-D81-autofix', 'CL-D72-route-autofix', 'CL-D72-map', 'CL-D40-autofix', 'CL-D50-base', 'CL-D83-autofix'];
const GAP_RECORDS = ['contract/AC-AUTOFIX.md', 'contract/CL-D39.md', 'contract/CL-D40.md', 'contract/CL-D51.md', 'contract/CL-D66.md'];

test('Issue #277 no clause pin names references/autofix.md, and the retired clauses are gone', () => {
  const ids = new Set();
  for (const source of manifestSources()) {
    for (const clause of JSON.parse(readText(source)).clauses) {
      ids.add(clause.id);
      assert.equal(clause.files.some((f) => f.endsWith('references/autofix.md')), false, `${source} ${clause.id} still pins the file`);
    }
  }
  for (const id of RETIRED) assert.equal(ids.has(id), false, `${id} is retired`);
  for (const id of ['AC-AUTOFIX', 'AC-GRANT', 'CL-D10', 'CL-D10-driver', 'CL-D25-commit', 'CL-D25-commit-publish', 'CL-D25-commit-record', 'CL-D27', 'CL-D27-record', 'CL-D3', 'CL-D30-language-boundary', 'CL-D30-precondition', 'CL-D30-preconditions', 'CL-D30-writability', 'CL-D30-isolated-workspace', 'CL-D39-recovery', 'CL-D39-driver', 'CL-D4', 'CL-D42-autofix', 'CL-D42-autofix-record', 'CL-D49-autofix', 'CL-D49-autofix-record', 'CL-D51-mapping', 'CL-D51-phases', 'CL-D51-record', 'CL-D64-writer', 'CL-D66-writer', 'CL-D79-definition']) assert.ok(ids.has(id), `${id} carries a repointed pin`);
});

test('Issue #277 the rule-stating tests read the code or the record, and the file is gone', () => {
  for (const name of RULE_TESTS) {
    const text = readText(`test/${name}.test.js`);
    assert.equal(text.includes('references/autofix.md') || text.includes('readAutofixProcedure'), false, `${name} still reads the file`);
  }
  // #249 C2 (CL-D119) deleted the file, so the structural reads each mixed file kept went with it, save a negative scan
  // that reads only files that remain (STILL_KEPT).
  for (const [name, { keep, gone }] of Object.entries(MIXED_TESTS)) {
    const text = readText(`test/${name}.test.js`);
    for (const line of keep) assert.equal(text.includes(line), STILL_KEPT.has(line), `${name}: ${line}`);
    for (const line of gone) assert.equal(text.includes(line), false, `${name} still states a rule from the file: ${line}`);
  }
  assert.equal(fs.existsSync(repoPath(FILE)), false, 'the file is deleted');
  assert.equal(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/autofix.md',"), false, 'AUTHORITY_FILES no longer measures the file');
  assert.equal(readText('test/helpers.js').includes('readAutofixProcedure'), false, 'the helper that read the file is gone');
});

test('Issue #277 the file is deleted, autofix.js no longer reads it into contractInput, and the byte alarms are unchanged', () => {
  assert.equal(fs.existsSync(repoPath(FILE)), false);
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];"), 'autofix.js hashes the PR Skill and the two shared references alone');
  assert.equal(readText('skills/closed-loop-pr/driver/review.js').includes('references/autofix.md'), false, 'review.js never read the file');
  const alarms = readText('test/issue-196-review-driver-4.test.js');
  assert.ok(alarms.includes("assert.ok(sizes.reduce((a, b) => a + b, 0) < 120000, 'driver aggregate alarm');") && alarms.includes('assert.ok(size < 30000,'), 'the driver alarms are not raised for the repoint (#281 later raised the aggregate, CL-D116)');
  // No new marker comment goes into the measured authority set.
  for (const file of ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) assert.equal(readText(file).includes('CL-D114'), false, `${file} gains no marker`);
  // The driver comments that cited the file by name cite the record instead, so the deletion leaves no dangling pointer.
  for (const file of ['autofix', 'phases', 'review', 'readiness', 'run', 'writer']) {
    const text = readText(`skills/closed-loop-pr/driver/${file}.js`).replace("'skills/closed-loop-pr/references/autofix.md'", '');
    assert.equal(/(?<![-\w])autofix\.md/.test(text), false, `${file}.js still points at the file by name`);
  }
});

test('Issue #277 CL-D114 records the repoint, the retired clauses and sentences, the gaps and the divergence', () => {
  const record = sectionOf(readContract(), '## CL-D114 — The clause pins of the autofix reference move to the code and the records');
  assert.ok(record, 'CL-D114 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105250786/);
  assert.match(record, /tetsuh\/pi-tidd-agents#277/);
  for (const id of RETIRED) assert.ok(record.includes(id), `CL-D114 names ${id}`);
  assert.match(record, /Five sentences were about the document or the prose path and are retired/);
  assert.match(record, /`REPLY_EXCEPTION` is not exercised \(AC-AUTOFIX\), only CL-D51's relaunch is recovered \(CL-D39\), the writer task does not carry the exactness rule \(CL-D66\), and no identity-gated worktree removal is drafted \(CL-D40\)/);
  assert.match(record, /a whitespace-only designated output is relaunched \(CL-D51, #275\)/);
  assert.match(record, /enterprise-policy constants are #276/);
  // Each gap and the divergence is recorded in its own record as well, under the record limit.
  for (const file of GAP_RECORDS) {
    const text = readText(file);
    assert.ok(text.includes('recorded and not closed (#249, CL-D114)'), `${file} records its gap`);
    assert.ok(Buffer.byteLength(text) < 8000, `${file} stays under the record limit`);
  }
  assert.match(readText('contract/AC-GRANT.md'), /The run-wide cap is five successful correction pushes, which the packaged autofix driver enforces as `CAP\.pushes` \(#249, CL-D114\)\./);
  assert.match(readText('contract/CL-D54.md'), /CL-D114 then dropped `references\/autofix\.md` from that comparison\./);
  // The index lists it above CL-D113, newest first.
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D114.md') !== -1 && index.indexOf('contract/CL-D114.md') < index.indexOf('contract/CL-D113.md'), 'CL-D114 is indexed above CL-D113');
});

'use strict';

// Issue #272 (#249 B2, CL-D113): since CL-D111 no run reads `references/review-only.md` as guidance (driver/review.js still
// hashes it into contractInput), and the last pull request of #249 deletes it. Before that, every clause pin and every
// rule-stating test read moves off the file to where the rule lives now: the driver or helper code that implements the
// rule where the file carries the record's marker (CL-D11, CL-D13 and CL-D38 added in driver comments, new or existing), else the record's own sentence. The file itself and the
// driver byte alarms were unchanged, so the pull request was behaviour-neutral; #249 later deleted the file (CL-D119).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readText, readContract, manifestSources, sectionOf } = require('./helpers');

const FILE = 'skills/closed-loop-pr/references/review-only.md';
// The rule-stating reads (AC2) leave the file entirely.
const RULE_TESTS = ['issue-193-external-review-state', 'issue-86-designated-output-path', 'issue-153-wording-only-minors', 'issue-64-validation-run', 'issue-34-bounded-recovery', 'pr-review-publication', 'issue-101-convergence-stage', 'issue-93-review-only-runtime-roots'];
// A file holding both kinds keeps only its structural reads: each named here, beside the rule-stating read it lost.
const MIXED_TESTS = {
  'closed-loop-regressions': {
    keep: ["const PR_REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';", 'assert.doesNotMatch(readText(PR_REVIEW_ONLY), /Exact PR `autofix`/);'],
    gone: ['assert.match(reviewOnly, /CL-D33 aggregate-summary publication is optional/);', 'for (const text of reviewOwned) assert.ok(reviewOnly.includes(text)', 'assert.match(review, /shared Every-gate invariant payload block verbatim/);'],
  },
  package: {
    keep: ["'review-only': 'skills/closed-loop-pr/references/review-only.md',", 'assert.match(reviewOnly, /## Gate loop \\(PR review-only baseline;/);'],
    gone: ['assert.match(reviewOnly, /A missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`\\./);', 'for (const text of reviewOnlyExclusive) assert.ok(reviewOnly.includes(text)'],
  },
  'issue-61-review-only-validation-sandbox': {
    keep: ['for (const file of [PR_REVIEW_ONLY, PR_AUTOFIX, PR_AUTOFIX_ADDENDUM]) {'],
    gone: ["const section = sectionOf(text, '### Validation sandbox boundary (CL-D38)');", "const prohibitions = sectionOf(text, '## Review-only is the default (AC-REVIEW-ONLY, CL-D15)');"],
  },
};
// The structural reads (existence, headings, duplication guards, derived vocabulary surfaces, contractInput) went with the
// file (#249, CL-D119).
const RETIRED = ['CL-D107-review-only', 'CL-D72-route-review-only', 'CL-D31-pr-boundary-pr'];

test('Issue #272 no clause pin names references/review-only.md, and the retired duplicates are gone', () => {
  const ids = new Set();
  for (const source of manifestSources()) {
    for (const clause of JSON.parse(readText(source)).clauses) {
      ids.add(clause.id);
      assert.equal(clause.files.some((f) => f.endsWith('references/review-only.md')), false, `${source} ${clause.id} still pins the file`);
    }
  }
  for (const id of RETIRED) assert.equal(ids.has(id), false, `${id} is retired`);
  for (const id of ['CL-D13-pr', 'CL-D33-boundary', 'CL-D38-review-only', 'CL-D54-review-only', 'CL-D62-pr', 'CL-D85-status', 'CL-D85-order', 'CL-D110-review-only', 'CL-D11-review-only', 'CL-D100-readiness', 'CL-D92-readiness', 'CL-D14-pr', 'CL-D17', 'CL-D18', 'CL-D23', 'CL-D24', 'CL-D28', 'AC-REVIEW-ONLY-record']) assert.ok(ids.has(id), `${id} carries a repointed pin`);
});

test('Issue #272 the rule-stating tests read the code or the record, and the file is gone', () => {
  for (const name of RULE_TESTS) assert.equal(readText(`test/${name}.test.js`).includes('references/review-only.md'), false, `${name} still reads the file`);
  // #249 C2 (CL-D119) deleted the file, so the structural reads each mixed file kept went with it.
  for (const [name, { keep, gone }] of Object.entries(MIXED_TESTS)) {
    const text = readText(`test/${name}.test.js`);
    for (const line of keep) assert.equal(text.includes(line), false, `${name}: ${line}`);
    for (const line of gone) assert.equal(text.includes(line), false, `${name} still states a rule from the file: ${line}`);
  }
  assert.equal(fs.existsSync(repoPath(FILE)), false, 'the file is deleted');
  assert.equal(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/review-only.md',"), false, 'AUTHORITY_FILES no longer measures the file');
});

test('Issue #272 the file is deleted, review.js no longer reads it into contractInput, and the byte alarms are unchanged', () => {
  assert.equal(fs.existsSync(repoPath(FILE)), false);
  assert.equal(readText('skills/closed-loop-pr/driver/review.js').includes("'skills/closed-loop-pr/references/review-only.md'"), false, 'review.js no longer reads the file into contractInput');
  assert.equal(readText('skills/closed-loop-pr/driver/autofix.js').includes('review-only.md'), false, 'autofix.js never read the file');
  const alarms = readText('test/issue-196-review-driver-4.test.js');
  assert.ok(alarms.includes("assert.ok(sizes.reduce((a, b) => a + b, 0) < 120000, 'driver aggregate alarm');") && alarms.includes('assert.ok(size < 30000,'), 'the driver alarms are not raised for the repoint (#281 later raised the aggregate, CL-D116)');
  // No new marker comment goes into the measured authority set.
  for (const file of ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) assert.equal(readText(file).includes('CL-D113'), false, `${file} gains no marker`);
  // The driver comments that cited the file by name cite the record instead, so the deletion leaves no dangling pointer.
  for (const file of ['review', 'phases', 'readiness', 'run']) {
    const text = readText(`skills/closed-loop-pr/driver/${file}.js`).replace("'skills/closed-loop-pr/references/review-only.md'", '');
    assert.equal(text.includes('review-only.md'), false, `${file}.js still points at the file by name`);
  }
});

test('Issue #272 CL-D113 records the repoint, the retired clauses and sentences, and the four gaps', () => {
  const record = sectionOf(readContract(), '## CL-D113 — The clause pins of the review-only reference move to the code and the records');
  assert.ok(record, 'CL-D113 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105250786/);
  assert.match(record, /tetsuh\/pi-tidd-agents#272/);
  for (const id of RETIRED) assert.ok(record.includes(id), `CL-D113 names ${id}`);
  assert.match(record, /retired/);
  assert.match(record, /Since CL-D111 no run reads `references\/review-only\.md` as guidance; `driver\/review\.js` still hashes it into `contractInput` until the last pull request of #249 deletes it\./);
  for (const gap of ['`review_misses`', 'SonarCloud', '`ABORTED`', 'pasted']) assert.ok(record.includes(gap), `CL-D113 records the gap: ${gap}`);
  assert.match(record, /recorded here, not closed/);
  assert.match(record, /No alarm is raised/);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D113.md') < index.indexOf('contract/CL-D112.md'), 'the index lists CL-D113 before CL-D112');
  assert.match(sectionOf(readContract(), '## CL-D54 — Review-only tolerates the runtime roots the harness itself writes'), /#249 later moved this record's pins to `driver\/run\.js` \(CL-D113\)/);
  for (const [id, gap] of [['CL-D85', 'always `none`'], ['CL-D17', 'no SonarCloud path'], ['CL-D14', 'Neither packaged driver emits `ABORTED`'], ['CL-D13', 'a pasted block is not read']]) {
    assert.ok(readText(`contract/${id}.md`).includes(gap), `${id} carries its gap sentence: ${gap}`);
    assert.ok(fs.statSync(repoPath(`contract/${id}.md`)).size < 8000, `${id} stays under the record limit`);
  }
});

'use strict';

// Issue #284 (#249 B4a, CL-D115): since CL-D111 no run reads `references/autofix-addendum.md` as guidance
// (driver/autofix.js still hashes it into contractInput), and the last pull request of #249 deletes it. Before that,
// CL-D30's clause pins and the tests that read the file as the statement of a CL-D30 rule move to where the rule lives
// now: the driver or helper code that implements it (CL-D30 in a writer.js comment, and the one guard label the batch
// chain lacked), else CL-D30's own sentence. The other nineteen clauses that name the file are B4b's. The file itself and
// the driver byte alarms were unchanged, so the pull request was behaviour-neutral; #249 later deleted the file (CL-D119).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readText, readContract, sectionOf } = require('./helpers');

const FILE = 'skills/closed-loop-pr/references/autofix-addendum.md';
const D30_HEADING = '## CL-D30 — Exact PR autofix publishes one bounded correction per public head';
const D115_HEADING = "## CL-D115 — CL-D30's clause pins of the autofix addendum move to the code and the record";
// The rule-stating reads (AC2) of CL-D30 rules leave the file entirely.
const RULE_TESTS = ['issue-86-designated-output-path'];
// A file holding both kinds keeps only its structural reads: each named here, beside the rule-stating read it lost.
const MIXED_TESTS = {
  'closed-loop-regressions': {
    keep: ["const PR_AUTOFIX_ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';", "const addendum = artifactSection(skill, '## Exact PR `autofix` addendum (CL-D30)');"],
    gone: ['const addendum = readText(PR_AUTOFIX_ADDENDUM);', "[PR_AUTOFIX_ADDENDUM, 'Exact PR `autofix` never resumes", "artifactSection(skill, '### Source-finding replies and final readiness')", "artifactSection(skill, '### Exact owner and safety boundary (CL-D30)')", "'Deduplicate `blockerKey × breakerOwner` values", 'assert.match(autofix, /shared `Every-gate invariant payload block` verbatim/);', '/final raw argument token is exactly `autofix`/'],
  },
  package: {
    keep: ['assert.match(addendumStage, /^## Exact PR `autofix` addendum \\(CL-D30\\)/);'],
    gone: ["[PR_AUTOFIX_ADDENDUM, 'Exact autofix malformed", 'assert.match(addendumStage, /Exact PR `autofix` has no uncommitted candidate'],
  },
  'pr-operational-cleanliness': {
    keep: ["const PR_ADDENDUM = readText('skills/closed-loop-pr/references/autofix-addendum.md');", "['publication', section(SKILL, '### Exact identity and Luna publication phases')],", "assert.ok(Buffer.byteLength(addendum) < 32000, 'the CL-D30 addendum must stay inside its recorded guard');"],
    gone: ["const phases = section(SKILL, '### Exact identity and Luna publication phases');", "const boundaries = section(SKILL, '### Public-head loop and evidence');", "const replies = section(SKILL, '### Source-finding replies and final readiness');", 'assert.ok((SKILL.match(/`REPLY_EXCEPTION`/g) || []).length >= 5', '/all three local dimensions remain independently guarded/gi', 'assert.match(SKILL, /every member of `RUNTIME_ROOTS`/);'],
  },
  'issue-181-commit-identity': {
    keep: ['assert.doesNotMatch(addendum, /Push exactly once with `git -C <AUTOFIX_WORKSPACE> push/'],
    gone: ['assert.match(addendum, /packaged `commit_create`/);', 'assert.match(addendum, /packaged `push_publish`/);'],
  },
  'issue-61-review-only-validation-sandbox': {
    keep: ['for (const file of [PR_REVIEW_ONLY, PR_AUTOFIX, PR_AUTOFIX_ADDENDUM]) {'],
    gone: ['assert.match(text, /AFTER_VALIDATION/);'],
  },
};
// The structural reads (existence, headings, the split, size and ranking, scanner coverage) went with the file (#249,
// CL-D119).
// The tests that read the file for another record's rule were B4b's (#249), each beside that record; B4b (#289,
// CL-D117) moved their reads, and those records no longer pin the file.
const B4B_TESTS = {
  'issue-34-bounded-recovery': 'CL-D39', 'issue-38-recovery-transition': 'CL-D39', 'issue-82-zero-output-relaunch': 'CL-D39', 'issue-169-post-push-revalidation': 'CL-D39',
  'issue-40-source-reply-markers': 'CL-D45', 'issue-51-anchored-findings': 'CL-D34', 'issue-96-named-guard-failures': 'CL-D55', 'issue-96-packaged-guards': 'CL-D57',
  'issue-100-gate-ids-v2': 'CL-D62', 'issue-101-convergence-stage': 'CL-D62', 'issue-110-derived-vocabulary': 'CL-D62', 'issue-114-message-verify': 'CL-D74',
  'issue-125-gate-step-builders': 'CL-D73', 'issue-153-wording-only-minors': 'CL-D85', 'issue-159-gate-launch-cwd': 'CL-D82', 'issue-193-external-review-state': 'CL-D92',
};
// A B4b file that also read a CL-D30 rule from the file has lost that read.
const B4B_GONE = { 'issue-51-anchored-findings': ['/at most 15 counted gate invocations and 5 successful correction pushes/', '/third observation of one unresolved `blockerKey × breakerOwner`/'] };
const RETIRED = ['CL-D30-breaker-boundaries', 'CL-D30-replies', 'CL-D30-reply-safety', 'CL-D30-summary-safety', 'CL-D30-pi-boundaries', 'CL-D30-pi-replies', 'CL-D30-readiness'];
const S30 = "The packaged autofix driver departs from the exact-autofix rules in five places, each recorded and not closed (#249, CL-D115): it assigns no breaker owner or confirmation gate, so any gate's report of an assigned finding as unresolved counts toward its third observation (CL-D96); it does not judge a finding's domain, so a finding in CL-D96's correctable class is corrected, a security or risk one included, unless its gate proposes an owner decision (#282); its staged manifest holds no tree OID, and the commit's tree is not compared with it after the commit; it re-reads the complete target before the writer launch and before the push, not at the first edit or the commit; and a gate's invocation number counts that gate's invocations, not the run's.";

test('Issue #284 no CL-D30 clause pins references/autofix-addendum.md, every CL-D30 pin matches, and the retired clauses are gone', () => {
  const clauses = JSON.parse(readText('contract/CL-D30.clauses.json')).clauses;
  const ids = new Set(clauses.map((clause) => clause.id));
  for (const clause of clauses) {
    assert.equal(clause.files.some((f) => f.endsWith('references/autofix-addendum.md')), false, `${clause.id} still pins the file`);
    for (const file of clause.files) {
      // As test/contract.test.js: a clause that names CONTRACT.md is checked against the whole contract.
      const text = file === 'CONTRACT.md' ? readContract() : readText(file);
      assert.ok(/CL-D30(?!\d)/.test(text), `${file} carries CL-D30 for ${clause.id}`);
      const scope = clause.section ? sectionOf(text, clause.section) : text;
      assert.ok(scope, `${clause.id} section ${clause.section} exists in ${file}`);
      for (const literal of clause.requires) assert.ok(scope.includes(literal), `${clause.id} pins ${file}: ${literal}`);
      if (file.endsWith('.js')) assert.equal('section' in clause, false, `${clause.id} pins code and names no section`);
    }
  }
  for (const id of RETIRED) assert.equal(ids.has(id), false, `${id} is retired`);
  for (const id of ['CL-D30-loop', 'CL-D30-publication', 'CL-D30-publication-commit', 'CL-D30-circuit', 'CL-D30-clean-boundaries', 'CL-D30-mode-safety', 'CL-D30-gate-correlation', 'CL-D30-luna-authorization', 'CL-D30-manifest', 'CL-D30-snapshot-routing', 'CL-D30-pi-publication', 'CL-D30-record']) assert.ok(ids.has(id), `${id} carries a repointed pin`);
  const byId = Object.fromEntries(clauses.map((clause) => [clause.id, clause]));
  assert.deepEqual(byId['CL-D30-luna-authorization'].files, ['skills/closed-loop-pr/driver/writer.js']);
  assert.deepEqual(byId['CL-D30-publication-commit'].files, ['skills/closed-loop-pr/helpers/publish.js']);
  assert.ok(byId['CL-D30-pi-publication'].requires.includes('// BEFORE_VALIDATION'), 'the seventh guard label is pinned');
  assert.deepEqual(byId['CL-D30-record'].files, ['contract/CL-D30.md']);
  // The record's Clauses line follows its manifest.
  assert.equal(readText('contract/CL-D30.md').split('\n')[1], `**Clauses:** ${clauses.map((clause) => clause.id).join(', ')}`);
});

test('Issue #284 the rule-stating tests read the code or the record, and the file is gone', () => {
  for (const name of RULE_TESTS) assert.equal(readText(`test/${name}.test.js`).includes('autofix-addendum'), false, `${name} still reads the file`);
  // #249 C2 (CL-D119) deleted the file, so the structural reads each mixed file kept went with it (issue-55 retired
  // whole, and test/issue-295-mode-references-deleted.test.js asserts it is gone).
  for (const [name, { keep, gone }] of Object.entries(MIXED_TESTS)) {
    const text = readText(`test/${name}.test.js`);
    for (const line of keep) assert.equal(text.includes(line), false, `${name}: ${line}`);
    for (const line of gone) assert.equal(text.includes(line), false, `${name} still states a CL-D30 rule from the file: ${line}`);
  }
  assert.equal(fs.existsSync(repoPath(FILE)), false, 'the file is deleted');
  assert.equal(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/autofix-addendum.md',"), false, 'AUTHORITY_FILES no longer measures the file');
  // #249 B4b (CL-D117) moved the B4b files' reads, and test/issue-289-addendum-rest-pins.test.js now holds the complete
  // inventory of the files that name the file; the CL-D30 reads B4a retired stay gone.
  for (const [name, record] of Object.entries(B4B_TESTS)) {
    assert.ok(fs.existsSync(repoPath(`test/${name}.test.js`)), `${name} exists`);
    const pins = JSON.parse(readText(`contract/${record}.clauses.json`)).clauses.filter((clause) => clause.files.some((f) => f.endsWith('references/autofix-addendum.md')));
    assert.deepEqual(pins, [], `${record} no longer pins the file after B4b`);
  }
  for (const [name, lines] of Object.entries(B4B_GONE)) {
    for (const line of lines) assert.equal(readText(`test/${name}.test.js`).includes(line), false, `${name} still states a CL-D30 rule from the file: ${line}`);
  }
  // B3's list of lines kept in pr-operational-cleanliness no longer holds the reply-exception count B4a retired.
  assert.equal(readText('test/issue-277-autofix-pins.test.js').includes('every provider-mutation boundary must reference REPLY_EXCEPTION'), false);
});

test('Issue #284 CL-D115 records the repoint, the retired clauses and the five divergences, and CL-D30 states them', () => {
  const record = sectionOf(readContract(), D115_HEADING);
  assert.ok(record, 'CL-D115 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105250786/);
  assert.match(record, /issues\/249#issuecomment-6118446239/);
  assert.match(record, /tetsuh\/pi-tidd-agents#284/);
  for (const id of RETIRED) assert.ok(record.includes(id), `CL-D115 names ${id}`);
  assert.match(record, /"destination language"/);
  assert.match(record, /`test\/issue-55-helper-invocation-map\.test\.js` compared the helper map's rows with the file's pre-push boundary enumeration, two prose files, and that check is retired; CL-D30-clean-boundaries pins the rechecks in the driver\./);
  assert.match(record, /The other nineteen clauses that name the file are B4b's \(#249\)/);
  assert.match(record, /no breaker owner or confirmation gate/);
  assert.match(record, /a security or risk finding in CL-D96's correctable class is corrected unless its gate proposes an owner decision \(#282\)/);
  assert.match(record, /no tree OID/);
  assert.match(record, /before the writer launch and before the push, not at the first edit or the commit/);
  assert.match(record, /counts per gate, not per run/);
  // CL-D30 states them in its own sentence, at the end of its validity line.
  const d30 = readText('contract/CL-D30.md');
  const validity = d30.split('\n').find((line) => line.startsWith('*Validity and invalidation conditions:*'));
  // #249 B4b (CL-D117) appends one more divergence after them, the push-visibility wait.
  assert.ok(validity.includes(` ${S30} After the push the packaged driver takes up to six snapshots`), 'CL-D30 states the five divergences at the end of its validity line, then CL-D117\'s');
  assert.ok(d30.includes('recorded and not closed (#249, CL-D115)'));
  for (const file of ['contract/CL-D30.md', 'contract/CL-D115.md']) assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
  // The index lists it above CL-D114, newest first.
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D115.md') !== -1 && index.indexOf('contract/CL-D115.md') < index.indexOf('contract/CL-D114.md'), 'CL-D115 is indexed above CL-D114');
});

test('Issue #284 the addendum is deleted, autofix.js no longer reads it into contractInput, and the byte alarms are unchanged', () => {
  assert.equal(fs.existsSync(repoPath(FILE)), false);
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];"), 'autofix.js hashes the PR Skill and the two shared references alone');
  const alarms = readText('test/issue-196-review-driver-4.test.js');
  assert.ok(alarms.includes("assert.ok(sizes.reduce((a, b) => a + b, 0) < 140000, 'driver aggregate alarm');") && alarms.includes('assert.ok(size < 30000,'), 'the driver alarms are not raised for the repoint (#281 and #306 later raised the aggregate, CL-D116 and CL-D122)');
  // The two code edits are comments: the guard label on the step that already ran first, and the writer's marker.
  assert.ok(driver.includes("  const overlay = step('overlay_freeze', { cwd: ws, authorizedPaths: b.authorizedPaths }); // BEFORE_VALIDATION\n"));
  assert.ok(readText('skills/closed-loop-pr/driver/writer.js').includes("// The writer's task: the guarded steps it runs itself, the paths it may edit, and the corrections as the gate gave them (CL-D30).\n"));
  // No new marker comment goes into the measured authority set.
  for (const file of ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) assert.equal(readText(file).includes('CL-D115'), false, `${file} gains no marker`);
});

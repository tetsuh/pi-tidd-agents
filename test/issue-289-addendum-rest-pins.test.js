'use strict';

// Issue #289 (#249 B4b, CL-D117): since CL-D111 no run reads `references/autofix-addendum.md` as guidance
// (driver/autofix.js still hashes it into contractInput), and the last pull request of #249 deletes it. After B4a
// (CL-D115) took CL-D30's pins, the other nineteen clauses and the tests that read the file for their rules move to where
// each rule lives now: the driver or helper code that implements it, else its record's sentence. Duplicates and the
// prose path retire; what the driver does not apply is recorded as a gap. The file and the byte alarms were unchanged;
// #249 later deleted the file (CL-D119).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readText, readContract, sectionOf, manifestSources } = require('./helpers');

const FILE = 'skills/closed-loop-pr/references/autofix-addendum.md';
const D117_HEADING = '## CL-D117 — The remaining clause pins of the autofix addendum move to the code and the records';
const RETIRED = ['CL-D73-addendum', 'CL-D74-addendum', 'CL-D77-addendum', 'CL-D85-misses', 'CL-D85-routing', 'CL-D92-prose', 'CL-D100-autofix-prose', 'CL-D107-addendum', 'CL-D55-addendum', 'CL-D57-addendum', 'CL-D78-addendum', 'CL-D82-addendum'];
// Where each moved pin went: code files for the rules the driver or a helper implements, else the record.
const REPOINTED = {
  'CL-D34-threat-model': ['contract/CL-D34.md'], 'CL-D34-normalization': ['contract/CL-D34.md'], 'CL-D34-normalization-builder': ['skills/closed-loop-pr/helpers/builders.js'],
  'CL-D39-stop': ['contract/CL-D39.md'], 'CL-D45-autofix': ['skills/closed-loop-pr/helpers/reply.js'], 'CL-D45-record': ['contract/CL-D45.md'],
  'CL-D55-guards': ['skills/closed-loop-pr/helpers/guards.js'], 'CL-D55-record': ['contract/CL-D55.md'], 'CL-D57-driver': ['skills/closed-loop-pr/driver/autofix.js'],
  'CL-D62-autofix': ['skills/closed-loop-pr/driver/autofix.js'], 'CL-D62-autofix-flow': ['skills/closed-loop-pr/driver/autofix.js'], 'CL-D78-driver': ['skills/closed-loop-pr/driver/writer.js'],
  'CL-D82-driver': ['skills/closed-loop-pr/driver/autofix.js'], 'CL-D85-readiness': ['skills/closed-loop-pr/driver/autofix.js'],
};
const RECORDS = ['CL-D34', 'CL-D39', 'CL-D45', 'CL-D55', 'CL-D57', 'CL-D62', 'CL-D73', 'CL-D74', 'CL-D77', 'CL-D78', 'CL-D82', 'CL-D85', 'CL-D92', 'CL-D100', 'CL-D107'];
// The rule-stating reads (AC2) leave the file entirely.
const RULE_TESTS = ['issue-38-recovery-transition', 'issue-40-source-reply-markers', 'issue-51-anchored-findings', 'issue-82-zero-output-relaunch', 'issue-96-named-guard-failures', 'issue-96-packaged-guards', 'issue-100-gate-ids-v2', 'issue-101-convergence-stage', 'issue-110-derived-vocabulary', 'issue-114-message-verify', 'issue-125-gate-step-builders', 'issue-159-gate-launch-cwd', 'issue-169-post-push-revalidation', 'issue-193-external-review-state'];
// A file holding both kinds keeps only its structural reads, each named beside the rule-stating read it lost.
const MIXED_TESTS = {
  'issue-34-bounded-recovery': {
    keep: ["assert.ok(text.indexOf('### Bounded pre-writer recovery (CL-D39)') < text.indexOf('except for the CL-D39 recovery defined above'));"],
    gone: ['assert.match(text, /Tool\\/startup\\/API\\/timeout'],
  },
  'issue-153-wording-only-minors': {
    keep: ['assert.ok(Buffer.byteLength(addendum) < 32000, `the CL-D30 addendum stays inside its reset guard: ${Buffer.byteLength(addendum)}`);'],
    gone: ["sectionOf(readText(ADDENDUM), '### Source-finding replies and final readiness')", "sectionOf(readText(ADDENDUM), '### Findings, no-progress, and deterministic status')", "readText('skills/closed-loop-pr/references/autofix-addendum.md')"],
  },
  'closed-loop-regressions': {
    keep: ["const autofix = (readText(PR_AUTOFIX) + '\\n' + readText(PR_AUTOFIX_ADDENDUM));", 'assert.doesNotMatch(autofix, /review-publication:v1/);'],
    gone: ['const drafting = autofix.split(', 'otherwise it reports `not_drafted'],
  },
};
const GAPS = {
  'contract/CL-D34.md': ['(#283): recorded and not closed (#249, CL-D117)', 'so no fresh finding is mapped to a settled key by counterexample class'],
  'contract/CL-D77.md': ['it drafts the artifacts at every stop once its target is bound', 'it never reports `not_drafted(<reason>)`', 'the comment calls that head the reviewed public head whether or not a gate reviewed it'],
  'contract/CL-D85.md': ["The packaged autofix driver records none either: its terminal report names no review miss and its status block's `review_misses` line is always `none`, recorded and not closed (#249, CL-D117)."],
  'contract/CL-D86.md': ['The packaged autofix driver does not recompose a refused post-push revalidation: the first refusal, after the push or at the recheck before a later gate or the writer, stops the run `BLOCKED`'],
  'contract/CL-D30.md': ['After the push the packaged driver takes up to six snapshots five seconds apart for the public head to show the commit before it stops `push_outcome_unknown`'],
};

test('Issue #289 no clause names references/autofix-addendum.md, the repointed pins match, and the retired clauses are gone', () => {
  const byId = {};
  for (const source of manifestSources()) for (const clause of JSON.parse(readText(source)).clauses) {
    byId[clause.id] = clause;
    assert.equal(clause.files.some((f) => f.endsWith('references/autofix-addendum.md')), false, `${clause.id} still pins the file`);
  }
  for (const id of RETIRED) assert.equal(id in byId, false, `${id} is retired or renamed`);
  for (const [id, files] of Object.entries(REPOINTED)) {
    assert.deepEqual(byId[id]?.files, files, `${id} pins ${files}`);
    for (const file of files) {
      const text = readText(file), scope = byId[id].section ? sectionOf(text, byId[id].section) : text;
      assert.ok(new RegExp(`${byId[id].marker}(?!\\d)`).test(text), `${file} carries ${byId[id].marker}`);
      for (const literal of byId[id].requires) assert.ok(scope.includes(literal), `${id} pins ${file}: ${literal}`);
      if (file.endsWith('.js')) assert.equal('section' in byId[id], false, `${id} pins code and names no section`);
    }
  }
  // Each record's Clauses line follows its manifest.
  for (const record of [...RECORDS, 'CL-D117']) {
    const ids = JSON.parse(readText(`contract/${record}.clauses.json`)).clauses.map((clause) => clause.id);
    assert.equal(readText(`contract/${record}.md`).split('\n')[1], `**Clauses:** ${ids.join(', ')}`, `${record} lists its clauses`);
  }
});

test('Issue #289 the rule-stating tests read the code or the record, and the mixed files keep no read of the file', () => {
  for (const name of RULE_TESTS) assert.equal(readText(`test/${name}.test.js`).includes('autofix-addendum'), false, `${name} still reads the file`);
  // #249 C2 (CL-D119) deleted the file, so the mixed files' structural reads went with it; test/issue-295-mode-references-deleted.test.js
  // holds the inventory of every test that still names any of the four deleted files.
  for (const [name, { keep, gone }] of Object.entries(MIXED_TESTS)) {
    const text = readText(`test/${name}.test.js`);
    for (const line of [...keep, ...gone]) assert.equal(text.includes(line), false, `${name}: ${line}`);
  }
});

test('Issue #289 CL-D117 records the repoint and the six gaps, and each record states its own', () => {
  const record = sectionOf(readContract(), D117_HEADING);
  assert.ok(record, 'CL-D117 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6118446239/);
  assert.match(record, /tetsuh\/pi-tidd-agents#289/);
  for (const id of RETIRED) assert.ok(record.includes(id), `CL-D117 names ${id}`);
  for (const gap of ['the threat model reaches no gate payload (CL-D34, #283)', 'no fresh finding is mapped to a settled key by counterexample class (CL-D34)', '`not_drafted` is never reported', 'no review miss is recorded (CL-D85)', 'a refused post-push revalidation is not recomposed (CL-D86)', 'after the push the driver waits for the public head to show the commit (CL-D30)']) assert.ok(record.includes(gap), `CL-D117 records ${gap}`);
  for (const [file, sentences] of Object.entries(GAPS)) {
    const text = readText(file);
    for (const sentence of sentences) assert.ok(text.includes(sentence), `${file}: ${sentence}`);
    assert.ok(text.includes('recorded and not closed (#249, CL-D117)'), `${file} records its gap`);
  }
  for (const file of [...Object.keys(GAPS), ...RECORDS.map((r) => `contract/${r}.md`), 'contract/CL-D117.md']) assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
  // CL-D34 now states the threat model the file stated.
  assert.match(readText('contract/CL-D34.md'), /Exact autofix assumes these operator conditions cooperative unless an Issue acceptance criterion names one: `TMPDIR`\/`TEMP`\/`TMP` and any supplied `runRoot` resolve outside the operator checkout;/);
  // B4a's record says where its inventory went.
  assert.match(readText('contract/CL-D115.md'), /CL-D117 later moved that inventory to `test\/issue-289-addendum-rest-pins\.test\.js`\./);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D117.md') !== -1 && index.indexOf('contract/CL-D117.md') < index.indexOf('contract/CL-D116.md'), 'CL-D117 is indexed above CL-D116');
});

test('Issue #289 the addendum is deleted, contractInput no longer hashes it, and the code changes were comments', () => {
  assert.equal(fs.existsSync(repoPath(FILE)), false);
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];"), 'autofix.js hashes the PR Skill and the two shared references alone');
  const alarms = readText('test/issue-196-review-driver-4.test.js');
  assert.ok(alarms.includes("assert.ok(sizes.reduce((a, b) => a + b, 0) < 120000, 'driver aggregate alarm');") && alarms.includes('assert.ok(size < 30000,'), 'the driver alarms are not raised');
  // The three code edits are comments.
  assert.ok(driver.includes("batchFail(run, operation, `${r.error?.code || r.data?.code} ${r.error?.message || ''}`.trim()); return r.data; }; // CL-D57\n"), 'the batch step carries CL-D57');
  assert.ok(readText('skills/closed-loop-pr/driver/writer.js').includes("// This run's unremoved workspace roots and their count, after any earlier operator action (ADV-208-RETAINED-ROOT-REPORT, CL-D78).\n"), 'the retained-root report carries CL-D78');
  const builders = readText('skills/closed-loop-pr/helpers/builders.js');
  assert.ok(builders.includes('// CL-D73: the parent still decides which fresh finding reopens which settled blocker — the counterexample-class\n// normalization CL-D34 states is its judgment — and states that judgment as data.'), 'the builder comment names CL-D34, not the file');
  assert.equal(builders.includes('autofix-addendum'), false, 'no packaged helper names the file');
  // No new marker comment goes into the measured authority set.
  for (const file of ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) assert.equal(readText(file).includes('CL-D117'), false, `${file} gains no marker`);
});

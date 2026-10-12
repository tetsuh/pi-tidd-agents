'use strict';

// Issue #284 (#249 B4a, CL-D115): since CL-D111 no run reads `references/autofix-addendum.md` as guidance
// (driver/autofix.js still hashes it into contractInput), and the last pull request of #249 deletes it. Before that,
// CL-D30's clause pins and the tests that read the file as the statement of a CL-D30 rule move to where the rule lives
// now: the driver or helper code that implements it (CL-D30 in a writer.js comment, and the one guard label the batch
// chain lacked), else CL-D30's own sentence. The other nineteen clauses that name the file are B4b's. The file itself and
// the driver byte alarms are unchanged, so the pull request is behaviour-neutral.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
// The structural reads (existence, headings, the split, size and ranking, scanner coverage) stay for the deletion.
const STRUCTURAL_TESTS = ['issue-87-addendum-split', 'issue-73-authority-budget', 'issue-164-map-split'];
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

test('Issue #284 the rule-stating tests read the code or the record; the mixed files keep only their structural reads; the structural reads stay', () => {
  for (const name of RULE_TESTS) assert.equal(readText(`test/${name}.test.js`).includes('autofix-addendum'), false, `${name} still reads the file`);
  for (const [name, { keep, gone }] of Object.entries(MIXED_TESTS)) {
    const text = readText(`test/${name}.test.js`);
    for (const line of keep) assert.ok(text.includes(line), `${name} keeps its structural read: ${line}`);
    for (const line of gone) assert.equal(text.includes(line), false, `${name} still states a CL-D30 rule from the file: ${line}`);
  }
  for (const name of STRUCTURAL_TESTS) assert.ok(readText(`test/${name}.test.js`).includes('autofix-addendum.md'), `${name} is the deletion pull request's and still reads the file`);
  assert.ok(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/autofix-addendum.md',"), 'AUTHORITY_FILES still measures the file until the deletion');
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
  assert.match(record, /The other nineteen clauses that name the file are B4b's \(#249\)/);
  assert.match(record, /no breaker owner or confirmation gate/);
  assert.match(record, /a security or risk finding in CL-D96's correctable class is corrected unless its gate proposes an owner decision \(#282\)/);
  assert.match(record, /no tree OID/);
  assert.match(record, /before the writer launch and before the push, not at the first edit or the commit/);
  assert.match(record, /counts per gate, not per run/);
  // CL-D30 states them in its own sentence, at the end of its validity line.
  const d30 = readText('contract/CL-D30.md');
  const validity = d30.split('\n').find((line) => line.startsWith('*Validity and invalidation conditions:*'));
  assert.ok(validity.endsWith(` ${S30}`), 'CL-D30 ends its validity line with the five divergences');
  assert.ok(d30.includes('recorded and not closed (#249, CL-D115)'));
  for (const file of ['contract/CL-D30.md', 'contract/CL-D115.md']) assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
  // The index lists it above CL-D114, newest first.
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D115.md') !== -1 && index.indexOf('contract/CL-D115.md') < index.indexOf('contract/CL-D114.md'), 'CL-D115 is indexed above CL-D114');
});

test('Issue #284 the addendum is byte-identical, autofix.js still reads it into contractInput, and the byte alarms are unchanged', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(repoPath(FILE))).digest('hex'), 'bc7420e709b490745f1d4fa6dd9423a78539314c88f9f7d73929f9a5c7c09803');
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/autofix.md', 'skills/closed-loop-pr/references/autofix-addendum.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];"), 'autofix.js still reads the file into contractInput');
  const alarms = readText('test/issue-196-review-driver-4.test.js');
  assert.ok(alarms.includes("assert.ok(sizes.reduce((a, b) => a + b, 0) < 110000, 'driver aggregate alarm');") && alarms.includes('assert.ok(size < 30000,'), 'the driver alarms are not raised for the repoint');
  // The two code edits are comments: the guard label on the step that already ran first, and the writer's marker.
  assert.ok(driver.includes("  const overlay = step('overlay_freeze', { cwd: ws, authorizedPaths: b.authorizedPaths }); // BEFORE_VALIDATION\n"));
  assert.ok(readText('skills/closed-loop-pr/driver/writer.js').includes("// The writer's task: the guarded steps it runs itself, the paths it may edit, and the corrections as the gate gave them (CL-D30).\n"));
  // No new marker comment goes into the measured authority set.
  for (const file of ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) assert.equal(readText(file).includes('CL-D115'), false, `${file} gains no marker`);
});

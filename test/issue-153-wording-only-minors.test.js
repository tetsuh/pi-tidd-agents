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
  // The sentence itself is pinned by 'rule 1 is bounded to the pull-request root and states both disjuncts'.
  assert.match(classes, /is recorded with its anchoring class and its disposition and does not stop the run, and readiness may be reported with such Minors recorded\./);
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
  assert.match(findings, /When a gate raises a finding of the same counterexample class as one the settled ledger already carries for an earlier head of this pull request, the run also records it/);
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /A Minor whose correction changes no file of the head is recorded with its disposition and never blocks `MERGE_READY` \(CL-D85\)\./);
});

test('Issue #153 CL-D85 records the three rules and the addendum guard reset', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D85 — Wording-only Minors do not stop a run');
  assert.ok(record, 'CL-D85 must exist');
  for (const field of ['*Decision ID:* CL-D85', '*Kind:* contract', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D85 must carry ${field}`);
  }
  assert.match(record, /issues\/153#issuecomment-5777454006/, 'the record cites the superseded choice it names');
  assert.match(record, /issues\/153#issuecomment-5780064415/, 'the record cites the owner choice the guards carry');
  assert.match(record, /The addendum's recorded guard resets from 29,000 to 32,000 bytes and the authority ceiling from 150,000 to 156,000 bytes for the three rules recorded here/);
  assert.match(record, /the headroom is asserted at the raise against the measurement taken when it was chosen — 29,776 and 149,602 bytes at `f71077f`, leaving 2,224 and 6,398/);
  // The records CL-D85 amends say so themselves.
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model') || '', /CL-D85/);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D67 — Pull-request bodies carry no per-head facts') || '', /CL-D85/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D85').map((clause) => clause.id).sort(),
    ['CL-D85-classes', 'CL-D85-gates', 'CL-D85-misses', 'CL-D85-order', 'CL-D85-readiness', 'CL-D85-record', 'CL-D85-routing', 'CL-D85-status', 'CL-D85-tests']);
  assert.ok(fs.existsSync(repoPath('test/issue-153-wording-only-minors.test.js')));
});

test('Issue #153 the reset guard is the one every suite asserts', () => {
  const addendum = readText(ADDENDUM);
  assert.ok(Buffer.byteLength(addendum) < 32000, `the CL-D30 addendum stays inside its reset guard: ${Buffer.byteLength(addendum)}`);
  const SELF = 'issue-153-wording-only-minors.test.js';  // this file names the superseded figure on purpose
  const carriers = [];
  for (const file of fs.readdirSync(repoPath('test'))) {
    if (!file.endsWith('.test.js') || file === SELF) continue;
    const text = readText(`test/${file}`);
    // A digit boundary, so the helper alarm's `< 290000` (CL-D89) is not read as the superseded addendum figure.
    assert.equal(/< 29000(?!\d)/.test(text), false, `${file} must not keep the superseded addendum guard`);
    if (text.includes('< 32000')) carriers.push(file);
  }
  assert.ok(carriers.length >= 7, `every suite that guards the addendum carries the reset figure: ${carriers.length}`);
  // The aggregate ceiling is untouched by this issue and still holds.
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + Buffer.byteLength(readText(file)), 0);
  assert.ok(total < 156000, `authority files total ${total}`);
});

// The pre-push adversarial pass on c424d48 found the first statement of these rules unimplementable in places:
// rule 1's gloss contradicted its own criterion and governed the Issue root, where "the head" does not exist;
// rule 3 named a status block in the mode that emits none; readiness stayed unreachable one conjunct over; and
// five mutations of the new text left the suite green.

const RULE1 = "In a pull-request run, a Minor whose correction changes no file of the head, or changes only wording that alters no obligation — no sentence the clause manifest pins and no behaviour a test asserts — is recorded with its anchoring class and its disposition and does not stop the run, and readiness may be reported with such Minors recorded.";

test('Issue #153 rule 1 is bounded to the pull-request root and states both disjuncts', () => {
  const classes = sectionOf(readText('skills/closed-loop-shared/references/records.md'), '## Finding anchoring classes (AC-ANCHOR, CL-D34)');
  assert.ok(classes.includes(RULE1), 'rule 1 names the root it applies to and both disjuncts');
  assert.equal(classes.includes('— a target-body edit, or a wording change that alters no obligation —'), false,
    'the gloss that called a wording change a correction changing no file must not survive');
  // The Issue root reads the same shared file and has no head; the rule must not reach it.
  assert.doesNotMatch(readText('skills/closed-loop-issue/SKILL.md'), /changes no file of the head/);
});

test('Issue #153 readiness is reachable when the only open findings are recorded Minors', () => {
  const readiness = sectionOf(readText('skills/closed-loop-pr/references/autofix-addendum.md'), '### Source-finding replies and final readiness');
  assert.match(readiness, /Sol and Terra both returned `MERGE` for the same exact head, counting a gate result whose only open findings are Minors recorded under CL-D85 as `MERGE` for that conjunct/);
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /A new finding other than a Minor recorded under CL-D85, a failed check, `Changes requested`, or a new head revokes readiness\./);
});

test('Issue #153 rule 3 is stated where the artifact that carries it exists', () => {
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.match(addendum, /the run also records it in its terminal report as a review miss of the gate and invocation that did not raise it \(CL-D85\)\./);
  assert.equal(addendum.includes('records it in the status block as a review miss'), false, 'exact autofix emits no status block');
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /When a gate raises a finding of the same counterexample class as one this run's ledger already carries for an earlier head of this pull request, record it in `review_misses` as a review miss of the gate and invocation that did not raise it \(CL-D85\)\./);
  assert.match(reviewOnly, /^review_misses: <counterexample class: the gate and invocation that did not raise it, one per line, or none>$/m);
  assert.equal(reviewOnly.includes('<finding class:'), false, 'the derived vocabulary is `counterexample class`, as CL-D34 states it');
});

test('Issue #153 the superseded guard figure and phrases leave the repository', () => {
  assert.equal(readText('CONTRACT.md').includes('may not reach 29,000 bytes'), false, 'no record may state the superseded guard in the present tense');
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D43 — Authority byte guards are set once, with headroom') || '', /CL-D85 later reset it to 32,000 bytes and the authority ceiling to 156,000 bytes on the same terms\./);
  assert.match(readText('test/issue-87-authority-floor.test.js'), /32,000 bytes since CL-D85 reset it/, 'the floor suite names the live figure in prose, and asserts none');
  assert.equal(readText('test/issue-87-authority-floor.test.js').includes('29,000 bytes'), false);
  // CL-D48: the headroom belongs to the moment of the raise, asserted against the figures the record names.
  assert.ok(32000 - 29776 > 2000, 'the addendum raise left room');
  assert.ok(156000 - 149602 > 6000, 'the ceiling raise left room');
  const retired = JSON.parse(readText('test/records/workflow-vocabulary.json')).retiredPhrases.map((entry) => entry.pattern);
  for (const phrase of ['[Tt]he chronology is appended after each review round', 'carries four parts and nothing else']) {
    assert.ok(retired.includes(phrase), `CL-D85 retires "${phrase}", so the denylist must carry it`);
  }
});

test('Issue #153 the new pins survive a mutation of what they pin', () => {
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  // A prose pin searched file-wide passes with the sentence moved out of the block it governs; a fixture file has
  // no sections, so the rule is for the Markdown clauses.
  for (const clause of manifest.clauses.filter((entry) => entry.marker === 'CL-D85' && entry.files.every((file) => file.endsWith('.md')))) {
    assert.ok(clause.section, `${clause.id} anchors its pin to a section, so a sentence moved out of it fails`);
  }
  // The amendment sentences are the only link between the superseded records and CL-D85; pin them by text.
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model'),
    /CL-D85 later narrowed what a finding under these classes stops: a Minor whose correction changes no file of the head is recorded with its anchoring class and its disposition and does not stop the run, which leaves the classes themselves unchanged\./);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D67 — Pull-request bodies carry no per-head facts'),
    /CL-D85 later moved the fourth part, the round chronology, out of the body to the target's timeline, so the body carries three parts and a review round edits none of them; the grant is unchanged by that move, and existing bodies are not rewritten\./);
  // A carrier is a file that asserts the live figure, not one that merely contains it.
  for (const file of ['test/issue-73-authority-budget.test.js', 'test/issue-87-addendum-split.test.js', 'test/issue-115-writer-pre-guard.test.js', 'test/issue-119-exactness-class.test.js', 'test/issue-120-pr-body-template.test.js', 'test/issue-126-sol-component-sweep.test.js', 'test/pr-operational-cleanliness.test.js']) {
    assert.match(readText(file), /assert\.ok\([^\n]*addendum[^\n]*< 32000/, `${file} asserts the reset addendum guard itself`);
  }
});

// ADV-171-CLD85-ROUTING-AND-RECORD-CONTRADICTIONS: relaxing readiness is not enough while every FIX verdict is a
// correction path and Terra waits for a literal Sol `MERGE`. The exception was unreachable in both modes, and the
// record still carried the two sentences the carriers had already corrected.

const ADVANCE = "A gate result whose only open findings are Minors recorded under CL-D85 advances as `MERGE` at every transition — convergence to Sol, Sol to Terra, and Terra to the final check — and is not a correction path; those findings stay recorded and dispositioned, and the head does not move for them.";

test('Issue #153 a qualifying gate result advances at every transition, in both modes', () => {
  for (const file of ['skills/closed-loop-pr/references/autofix-addendum.md', 'skills/closed-loop-pr/references/review-only.md']) {
    assert.ok(readText(file).includes(ADVANCE), `${file} states the transition rule`);
  }
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /\*\*Never start the Terra gate before the Sol gate returns `MERGE`, counting a result whose only open findings are Minors recorded under CL-D85 as `MERGE` \(CL-D85\)\.\*\*/);
  assert.match(reviewOnly, /→ preliminary disposition \(a `FIX BEFORE MERGE` stops at `WAITING_FOR_OWNER` before Sol, unless its only open findings are Minors recorded under CL-D85\)/);
});

test('Issue #153 the CL-D85 record says what its carriers say', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D85 — Wording-only Minors do not stop a run');
  assert.ok(record.includes('a Minor whose correction changes no file of the head, or changes only wording that alters no obligation — no sentence the clause manifest pins and no behaviour a test asserts — is recorded'),
    'the record states the two disjuncts the carriers state');
  assert.equal(record.includes('— a target-body edit, or a wording change that alters no obligation —'), false,
    'the superseded gloss must not survive in the authoritative record');
  assert.match(record, /records it in its terminal report, and in review-only in the status block's `review_misses`, as a review miss of the gate and invocation that did not raise it/);
  assert.equal(record.includes('records it in the status block as a review miss of the round'), false,
    'exact autofix emits no status block, so the record may not send it there');
  assert.ok(record.includes(ADVANCE), 'the record carries the transition rule its carriers state');
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pins = manifest.clauses.filter((clause) => clause.marker === 'CL-D85').flatMap((clause) => clause.requires);
  assert.ok(pins.some((sentence) => sentence.includes('advances as `MERGE` at every transition')), 'the manifest pins the transition rule');
});

// ADV-171-CLD85-ROUTING-AND-RECORD-CONTRADICTIONS, reopened: the mode references carried the exception while the
// authority they both answer to, AC-GATES, still required a literal Sol `MERGE`.
test('Issue #153 AC-GATES carries the CL-D85 counting rule', () => {
  const gates = sectionOf(readText('CONTRACT.md'), '## AC-GATES — Sequential Sol then Terra');
  assert.ok(gates, 'AC-GATES must exist');
  assert.match(gates, /The Terra gate never starts before the Sol gate returns `MERGE`\. In a pull-request run, a Sol result whose only open findings are Minors recorded under CL-D85 counts as `MERGE` for that prerequisite \(CL-D85\)\./);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pins = manifest.clauses.filter((clause) => clause.marker === 'CL-D85').flatMap((clause) => clause.requires);
  assert.ok(pins.some((sentence) => sentence.includes('counts as `MERGE` for that prerequisite')), 'the manifest pins the AC-GATES qualification');
});

// CONV-171-STALE-GUARD-DIAGNOSTIC, recorded as a non-blocking Minor under the rule this PR adds, and corrected here.
test('Issue #153 the ceiling diagnostic names the ceiling it enforces', () => {
  assert.equal(readText('test/package.test.js').includes('expected less than 150000'), false);
  assert.match(readText('test/package.test.js'), /expected less than 156000/);
});

// Three mutations survived the pass on this branch: a sentence appended to AC-GATES cancelling the counting rule,
// and deletion of each of the two bars CL-D85 sets. Positive substring pins cannot see either, so AC-GATES is
// pinned whole and the bars are pinned by text.
test('Issue #153 AC-GATES carries those two sentences and nothing else', () => {
  const gates = sectionOf(readText('CONTRACT.md'), '## AC-GATES — Sequential Sol then Terra');
  const body = gates.split('\n').slice(1).join('\n').trim();
  assert.equal(body, '**Clauses:** AC-GATES\n\nThe Terra gate never starts before the Sol gate returns `MERGE`. In a pull-request run, a Sol result whose only open findings are Minors recorded under CL-D85 counts as `MERGE` for that prerequisite (CL-D85).',
    'a sentence added here can cancel the counting rule while every positive pin still passes');
});

test('Issue #153 the bars CL-D85 sets are pinned, not only its permissions', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D85 — Wording-only Minors do not stop a run');
  assert.match(record, /Treating a `Blocker` or `Major` as wording only, reporting readiness with an undispositioned finding, or returning the chronology to the body requires a new owner decision\./);
  assert.match(record, /A finding that corrects a false safety claim changes what the contract promises, so it is not wording only and keeps its severity\./);
  // What the packaged validator can represent today, and where the rest is being decided.
  assert.match(record, /The packaged validator does not yet represent this class: `checkVerdict` treats a fresh Minor with an anchoring class and a no-code disposition as unresolved/);
  assert.match(record, /Until that is decided \(Issue #172\)/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pins = manifest.clauses.filter((clause) => clause.marker === 'CL-D85').flatMap((clause) => clause.requires);
  for (const bar of ['Treating a `Blocker` or `Major` as wording only', 'it is not wording only and keeps its severity']) {
    assert.ok(pins.some((sentence) => sentence.includes(bar)), `the manifest pins the bar: ${bar}`);
  }
});

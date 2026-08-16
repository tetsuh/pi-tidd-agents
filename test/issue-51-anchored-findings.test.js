'use strict';

// Issue #51 / CL-D34: Sol findings are anchored to acceptance criteria and a
// declared threat model. These are compile/contract assertions over the shipped
// prose; they cannot prove runtime model compliance.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson } = require('./helpers');

const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const RECORDS = 'skills/closed-loop-shared/references/records.md';
const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const PR_REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const ISSUE_SKILL = 'skills/closed-loop-issue/SKILL.md';
const AGENT_FILES = ['agents/sol-reviewer.md', 'agents/terra-reviewer.md', 'agents/luna-worker.md', 'agents/terra-oracle.md', 'agents/terra-worker.md', 'agents/glm-worker.md'];

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

test('Issue #51 shared gate contract anchors blocking findings to criteria, clauses, or invariants', () => {
  const shared = readText(GATE_CONTRACT);
  const anchor = sectionOf(shared, '### Finding anchoring and threat-model bound (AC-ANCHOR, CL-D34)');
  assert.ok(anchor, 'AC-ANCHOR section is missing from the shared gate contract');
  assert.match(anchor, /Every `Blocker` or `Major` finding names the acceptance criterion, contract clause, or fail-stop invariant/);
  assert.match(anchor, /appears only in target-body prose[^.]*`reword` finding/);
  assert.match(anchor, /owner edit of the body, never an implementation blocker/);
  assert.match(anchor, /assumed operator condition declared cooperative by the selected mode's threat model[^.]*`follow-up` finding/);
  assert.match(anchor, /proposed issue title/);
  assert.match(anchor, /unless an acceptance criterion names that condition/);
  assert.match(anchor, /Bounding applies to severity and disposition only/);
  assert.match(anchor, /still reports every cited counterexample/);
  // The bound lives inside the adversarial section so it is read with the procedure it bounds.
  const adversarial = sectionOf(shared, '## Sol adversarial consistency check (AC-ADVERSARIAL, CL-D29)');
  assert.ok(adversarial.includes(anchor), 'AC-ANCHOR must be a subsection of AC-ADVERSARIAL');
});

test('Issue #51 Sol-only payload block carries the anchoring bound verbatim for every Sol invocation', () => {
  const shared = readText(GATE_CONTRACT);
  const sol = sectionOf(shared, '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(sol);
  assert.match(sol, /Every `Blocker` or `Major` finding names the acceptance criterion, contract clause, or fail-stop invariant it falsifies/);
  assert.match(sol, /a claim found only in target-body prose with no criterion is a `reword` finding corrected by owner body edit, not an implementation blocker/);
  assert.match(sol, /a counterexample requiring violation of an assumed operator condition declared cooperative by the selected mode's threat model is a `follow-up` finding with a proposed issue title unless an acceptance criterion names that condition/);
  assert.match(sol, /\(CL-D34\)/);
  // The unbounded procedure is preserved: bounding changes severity and disposition, not the search.
  assert.match(sol, /attempt falsification against the authoritative files of the repository under review/);
  assert.match(sol, /never invent a counterexample/);
  assert.equal((shared.match(/Treat the exact target body \(the Issue or pull-request body as applicable\)/g) || []).length, 1);
});

test('Issue #51 records reference defines exactly three anchoring classes and keeps the disposition vocabulary closed', () => {
  const records = readText(RECORDS);
  const classes = sectionOf(records, '## Finding anchoring classes (AC-ANCHOR, CL-D34)');
  assert.ok(classes, 'anchoring class section is missing');
  assert.match(classes, /Label every finding with exactly one anchoring class before its disposition/);
  assert.match(classes, /```text\ncriterion-anchored\nreword\nfollow-up\n```/);
  assert.match(classes, /`reword` traces only to target-body prose/);
  assert.match(classes, /disposition `fixed` on the body revision or `accepted-as-designed`/);
  assert.match(classes, /`follow-up` requires violating an assumed operator condition/);
  assert.match(classes, /disposition `deferred` with a proposed issue title/);
  assert.match(classes, /never a blocker unless an acceptance criterion names that condition/);
  const dispositions = sectionOf(records, '## Finding dispositions (AC-DISPOSITION)');
  assert.match(dispositions, /```text\nfixed\naccepted-as-designed\ndeferred\nduplicate\nnot-applicable\nneeds-owner-decision\n```/);
  assert.doesNotMatch(dispositions, /reword|follow-up/, 'anchoring classes are not dispositions');
});

test('Issue #51 exact autofix declares its threat model and normalizes new blocker keys against the settled ledger', () => {
  const autofix = readText(PR_AUTOFIX);
  const model = sectionOf(autofix, '### Exact-autofix threat model (CL-D34)');
  assert.ok(model, 'threat-model section is missing from the exact-autofix reference');
  assert.match(model, /assumes these operator conditions cooperative unless an Issue acceptance criterion names one/);
  for (const condition of [
    /`TMPDIR`\/`TEMP`\/`TMP` and any supplied `runRoot` resolve outside the operator checkout/,
    /Git configuration is not mutated by a third party during the run/,
    /not concurrently hostile between one discrete no-follow observation and the next Git operation/,
    /schema-valid responses for supported endpoints/,
    /does not run another writer against the same checkout or workspace/,
  ]) assert.match(model, condition);
  assert.match(model, /Helpers that detect a violated assumption still fail closed/);
  assert.match(model, /`follow-up` finding under AC-ANCHOR \(CL-D34\)/);
  assert.match(model, /a claim only in PR-body prose is `reword`/);
  const findings = sectionOf(autofix, '### Findings, no-progress, and deterministic status');
  assert.match(findings, /Before assigning a new `blockerKey`, the parent normalizes the finding against the settled ledger by counterexample class/);
  assert.match(findings, /same helper or clause, same invariant, different input/);
  assert.match(findings, /reopen of the settled key requiring materially new evidence, never as a new key \(CL-D34\)/);
  // The 15/5/third-observation breakers are unchanged.
  assert.match(findings, /at most 15 counted gate invocations and 5 successful correction pushes/);
  assert.match(findings, /third observation of one unresolved `blockerKey × breakerOwner`/);
});

test('Issue #51 leaves review-only, Issue, and agent files without a threat model of their own', () => {
  assert.doesNotMatch(readText(PR_REVIEW_ONLY), /threat model/i);
  assert.doesNotMatch(readText(ISSUE_SKILL), /threat model/i);
  for (const file of AGENT_FILES) assert.doesNotMatch(readText(file), /CL-D34|AC-ANCHOR|threat model/i, `${file} must stay unchanged`);
});

test('Issue #51 CONTRACT.md records CL-D34 with its clauses, the raised authority baseline, and CL-D29 cross-reference', () => {
  const contract = readText('CONTRACT.md');
  const section = sectionOf(contract, '## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model');
  assert.ok(section, 'CL-D34 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D34-anchor, CL-D34-payload, CL-D34-classes, CL-D34-threat-model, CL-D34-normalization, CL-D34-readme, CL-D34-baseline$/m);
  assert.match(section, /^\*Decision ID:\* CL-D34$/m);
  assert.match(section, /^\*Kind:\* contract$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#51/);
  assert.match(section, /PR #48/);
  assert.match(section, /104,000/);
  assert.match(section, /99,182/);
  const manifest = readJson('test/contract-clauses.json');
  const ids = manifest.clauses.filter((clause) => clause.marker === 'CL-D34').map((clause) => clause.id).sort();
  assert.deepEqual(ids, ['CL-D34-anchor', 'CL-D34-baseline', 'CL-D34-classes', 'CL-D34-normalization', 'CL-D34-payload', 'CL-D34-readme', 'CL-D34-threat-model']);
  const cl29 = sectionOf(contract, '## CL-D29 — Sol attempts adversarial falsification of absolute claims');
  assert.match(cl29, /CL-D34 bounds the severity and disposition of the findings this procedure produces/);
  assert.match(readText('README.md'), /Under CL-D34, every blocking Sol finding is anchored to an acceptance criterion, contract clause, or fail-stop invariant/);
});

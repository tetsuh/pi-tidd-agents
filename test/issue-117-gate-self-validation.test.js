'use strict';

// Issue #117 (CL-D65) — gate children keep returning envelopes that pass the runner's JSON-schema
// check and fail the packaged semantic validator (#104 Terra, #109 Sol twice, #113 convergence
// four times), each costing the route's only retry. The schema cannot express the three rules the
// validator enforces, so the Every-gate payload block now states them, and every reviewer child
// validates its own draft with the packaged validator before submitting.
//
// TDD provenance: pre-implementation compile/contract RED — every assertion inspects artifact text
// (Markdown, JSON), recorded with `node --test test/issue-117-gate-self-validation.test.js` at 0
// passes / 3 failures before the prose, the agent sentences, the record, and the clauses existed;
// the record-semantics assertions below are review-driven regressions (ADV-118-CLD65-MANIFEST-INCOMPLETE).
// That local output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const REVIEWERS = ['tidd-adversarial-reviewer', 'tidd-drift-reviewer', 'tidd-safety-reviewer', 'tidd-convergence-reviewer'];
// The three envelope duties, stated once here and required verbatim in both the payload block and the record,
// so the authoritative record cannot drift from what the launch payload tells the child.
const DUTIES = [
  'every parent-assigned finding appears in `findings` with `origin: assigned`, its exact tuple, and exactly one confirmation',
  'a fresh finding carries no `blockerKey`',
  'an adversarial result links a `findingId` only for a counterexample or unavailable-evidence outcome, and only to an id present in `findings`',
];
const SELF_VALIDATION = /Before submitting the structured envelope, run the packaged `gate_result_validate` named in the payload on your draft with the supplied expectation and submit only a validated envelope; a rejected draft is yours to fix, not the parent's\./;

test('Issue #117 the Every-gate block states the envelope duties and the self-validation duty', () => {
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(block, 'the Every-gate block must exist');
  assert.ok(block.includes(`The envelope duties the schema cannot express: ${DUTIES.join('; ')}.`), 'the block states the three duties verbatim');
  assert.match(block, /The parent's volatile envelope names the host-trusted packaged CLI path and the expectation file; before submitting, the child runs `gate_result_validate` on its draft with that expectation and submits only a validated envelope \(CL-D65\)/);
});

test('Issue #117 every reviewer body carries the self-validation sentence and the writer does not', () => {
  for (const name of REVIEWERS) assert.match(readText(`agents/${name}.md`), SELF_VALIDATION, `${name} carries the self-validation sentence`);
  assert.doesNotMatch(readText('agents/tidd-autofix-worker.md'), SELF_VALIDATION, 'the writer returns no gate envelope');
});

test('Issue #117 CL-D65 records the duty and widens CL-D1 once more', () => {
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D65 — Gate children carry the envelope duties and validate their own envelope');
  assert.ok(record, 'CL-D65 must exist');
  for (const field of ['*Decision ID:* CL-D65', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D65 must carry ${field}`);
  assert.match(record, /issues\/117/);
  assert.match(record, /widens the CL-D1 `agents\/` freeze exactly once more, for one sentence in each of the four reviewer bodies/);
  assert.match(record, /the validator, the schema, and every route's retry rule are unchanged/);
  // Review-driven (ADV-118-CLD65-MANIFEST-INCOMPLETE): the record's semantics, not only its labels, are pinned.
  for (const duty of DUTIES) assert.ok(record.includes(duty), `the CL-D65 owner choice states: ${duty}`);
  assert.match(record, /the child submits only an envelope `gate_result_validate` accepted against the supplied expectation/);
  assert.match(record, /Option B relaxes the validator or adds a repair step, which moves verdict authority toward an unvalidated document and is declined/);
  assert.match(record, /Option C raises the children's thinking level, which does not teach them a rule they cannot see/);
  assert.match(record, /a child that submits a rejected envelope is handled exactly as before/);
  assert.match(record, /letting the child's own run substitute for the parent's `gate_result_validate` requires a new owner decision/);
  assert.match(record, /the writer body is unchanged because it returns no gate envelope/);
  assert.match(sectionOf(contract, '## CL-D1 — Gate verdicts are supplied by the caller, not by agent files'), /CL-D65 later added the self-validation sentence to the four reviewer bodies under its own widening/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D65').map((clause) => clause.id).sort(), ['CL-D65-payload', 'CL-D65-record', 'CL-D65-tests']);
  const recordClause = manifest.clauses.find((clause) => clause.id === 'CL-D65-record');
  for (const duty of DUTIES) assert.ok(recordClause.requires.includes(duty), `CL-D65-record pins: ${duty}`);
});

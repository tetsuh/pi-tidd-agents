'use strict';

// Issue #126 (CL-D73) — when an adversarial finding exhibits a counterexample against a component, the
// gate attacks that same component exhaustively before it returns, and reports every counterexample it
// finds in that one result. On PR #124 the spawn guard took five rounds, `required_evidence_set` three,
// and `validation_run` two, each round delivering the next counterexample against a component an
// earlier round had already broken, at about an hour and a full gate invalidation per round.
//
// TDD provenance: pre-implementation compile/contract RED (not behavioral RED: every assertion inspects
// artifact text), recorded with `node --test test/issue-126-sol-component-sweep.test.js` at 0 passes / 2
// failures before the sentence, the record, and the manifest clauses existed. That local output is not
// claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, repoPath, sectionOf, AUTHORITY_FILES } = require('./helpers');

const SENTENCE = 'When a finding exhibits a counterexample against a component, attempt every other counterexample class against that same component — its other inputs, encodings, syntax forms, and boundaries — and report all that succeed in that one result, so the component is corrected once (CL-D73).';

test('Issue #126 the adversarial gate exhausts a broken component before it returns', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  const sol = sectionOf(contract, '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(sol, 'the Sol-only block must exist');
  assert.ok(sol.includes(SENTENCE), 'the Sol-only block must carry the component-sweep sentence verbatim');
  // It stands beside CL-D66's same-class rule, which it extends from one check to one component.
  assert.ok(sol.indexOf('name every check of the same class across the target in that one result') < sol.indexOf(SENTENCE), 'the sweep sentence follows the same-class rule');
  // A Sol duty only: the every-gate block every role receives is unchanged, and so are the other roles.
  const everyGate = sectionOf(contract, '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(everyGate && !everyGate.includes('CL-D73'), 'the every-gate block carries no Sol-only duty');
  for (const file of ['skills/closed-loop-pr/references/autofix-addendum.md', 'skills/closed-loop-pr/references/review-only.md']) {
    assert.doesNotMatch(readText(file), /CL-D73/, `${file} must not carry the Sol-only duty`);
  }
  for (const file of ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/SKILL.md']) {
    assert.doesNotMatch(readText(file), /CL-D73/, `${file} must not carry the Sol-only duty`);
  }
  assert.match(contract, /never the Sol-only adversarial block/, 'the convergence child still never receives the Sol-only block');
  const carriers = AUTHORITY_FILES.filter((file) => readText(file).includes(SENTENCE));
  assert.deepEqual(carriers, ['skills/closed-loop-shared/references/gate-contract.md'], 'exactly one authority file carries the sentence');
  assert.ok(Buffer.byteLength(readText('skills/closed-loop-pr/references/autofix-addendum.md')) < 28000, 'the CL-D30 addendum stays inside its recorded guard');
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 150000, `authority files total ${total}; the sentence must fit under the ceiling without a raise`);
});

test('Issue #126 CL-D73 records the placement, the declined alternatives, and the boundary', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D73 — A component broken once is attacked exhaustively before the gate returns');
  assert.ok(record, 'CL-D73 must exist');
  for (const field of ['*Decision ID:* CL-D73', '*Kind:* contract', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D73 must carry ${field}`);
  }
  assert.match(record, /issues\/126#issuecomment-5671862619/);
  assert.match(record, /re-invoking the gate for each component costs a counted gate and a full review, and is declined/);
  assert.match(record, /no verdict rule, no severity, no anchoring class, and no round budget changes/);
  assert.match(record, /the writer and the pre-push sweep carry the whole burden/);
  assert.match(record, /The duty ends where the gate's evidence ends/);
  assert.match(record, /recorded as its own decision so that closed record is not edited, and the pin is a test rather than a fixture/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D73').map((clause) => clause.id).sort(), ['CL-D73-payload', 'CL-D73-record', 'CL-D73-tests']);
  const payloadClause = manifest.clauses.find((clause) => clause.id === 'CL-D73-payload');
  assert.deepEqual([payloadClause.files, payloadClause.section], [['skills/closed-loop-shared/references/gate-contract.md'], '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)']);
  assert.ok(payloadClause.requires.includes(SENTENCE), 'the manifest pins the sentence verbatim');
  assert.ok(fs.existsSync(repoPath('test/issue-126-sol-component-sweep.test.js')));
});

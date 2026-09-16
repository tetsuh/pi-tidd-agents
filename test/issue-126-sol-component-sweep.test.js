'use strict';

// Issue #126 (CL-D66) — when an adversarial finding exhibits a counterexample against a component, the
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

const SENTENCE = 'When a finding exhibits a counterexample against a component, attempt every other counterexample class against that same component — its other inputs, encodings, syntax forms, and boundaries — and report all that succeed in that one result, so the component is corrected once.';

test('Issue #126 the adversarial gate exhausts a broken component before it returns', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  const sol = sectionOf(contract, '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(sol, 'the Sol-only block must exist');
  assert.ok(sol.includes(SENTENCE), 'the Sol-only block must carry the component-sweep sentence verbatim');
  // It stands beside CL-D66's same-class rule, which it extends from one check to one component.
  assert.ok(sol.indexOf('name every check of the same class across the target in that one result') < sol.indexOf(SENTENCE), 'the sweep sentence follows the same-class rule');
  // A Sol duty only: the every-gate block every role receives is unchanged, and so are the other roles.
  const everyGate = sectionOf(contract, '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(everyGate && !everyGate.includes(SENTENCE), 'the every-gate block carries no Sol-only duty');
  for (const file of ['skills/closed-loop-pr/references/autofix-addendum.md', 'skills/closed-loop-pr/references/review-only.md']) {
    assert.ok(!readText(file).includes(SENTENCE), `${file} must not carry the Sol-only duty`);
  }
  for (const file of ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/SKILL.md']) {
    assert.ok(!readText(file).includes(SENTENCE), `${file} must not carry the Sol-only duty`);
  }
  assert.match(contract, /never the Sol-only adversarial block/, 'the convergence child still never receives the Sol-only block');
  // The extension is owned by CL-D66, as Issue #126 placed it: no separate record, and the sentence is the issue's own.
  // Pinned by ownership rather than by the next free decision id: an id is free only until the next decision takes it,
  // and what Issue #126 placed is that one record owns the extension. CL-D73 later took that id for another decision.
  const owners = readText('CONTRACT.md').split(/^## /m).slice(1)
    .filter((record) => record.includes('issues/126#issuecomment-5671862619'))
    .map((record) => record.split(' ')[0]);
  assert.deepEqual(owners, ['CL-D66'], 'the extension belongs to CL-D66, not to a record of its own');
  const carriers = AUTHORITY_FILES.filter((file) => readText(file).includes(SENTENCE));
  assert.deepEqual(carriers, ['skills/closed-loop-shared/references/gate-contract.md'], 'exactly one authority file carries the sentence');
  assert.ok(Buffer.byteLength(readText('skills/closed-loop-pr/references/autofix-addendum.md')) < 29000, 'the CL-D30 addendum stays inside its recorded guard');
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 150000, `authority files total ${total}; the sentence must fit under the ceiling without a raise`);
});

test('Issue #126 CL-D66 records the component sweep, its declined alternatives, and its boundary', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D66 — Same-class rigor gaps are named once and written exactly the first time');
  assert.ok(record, 'CL-D66 must exist');
  for (const field of ['*Decision ID:* CL-D66', '*Kind:* contract', '*Options and trade-offs:*', '*Owner choice:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D66 must carry ${field}`);
  }
  assert.match(record, /issues\/126#issuecomment-5671862619/);
  assert.match(record, /re-invoke the gate against the named component after each finding, which costs a counted gate and a full review and is declined/);
  assert.match(record, /changes no verdict rule, no severity, no anchoring class, and no round budget/);
  assert.match(record, /leaves the writer and the pre-push sweep carrying the whole burden/);
  assert.match(record, /ends where the gate's evidence ends/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D66').map((clause) => clause.id).sort(), ['CL-D66-payload', 'CL-D66-record', 'CL-D66-sweep', 'CL-D66-sweep-tests', 'CL-D66-tests', 'CL-D66-writer']);
  const payloadClause = manifest.clauses.find((clause) => clause.id === 'CL-D66-sweep');
  assert.deepEqual([payloadClause.files, payloadClause.section], [['skills/closed-loop-shared/references/gate-contract.md'], '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)']);
  assert.ok(payloadClause.requires.includes(SENTENCE), 'the manifest pins the sentence verbatim');
  assert.ok(fs.existsSync(repoPath('test/issue-126-sol-component-sweep.test.js')));
});

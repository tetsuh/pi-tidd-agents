'use strict';

// Issue #304 (CL-D121), step 2a of #190. CL-D62 ran a non-authoritative convergence stage before the adversarial gate on
// both roots; the owner took it off the Issue root to keep Issue review light (issues/190#issuecomment-6243884276). The
// Issue root orders Sol, then Terra, and refuses a convergence gate; the pull-request root keeps the stage unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, readContract, sectionOf, readManifest, readJson, issueCorrelationOf } = require('./helpers');

const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const EVIDENCE = [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }];
const prCorrelation = (gate) => ({ repository: 'o/r', number: 304, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) });
const correlationOf = (workflow, gate) => (workflow === 'pr' ? prCorrelation(gate) : issueCorrelationOf(prCorrelation(gate)));
const expectation = (workflow, gate) => ({ workflow, correlation: correlationOf(workflow, gate), assignedFindings: [], requiredEvidence: EVIDENCE });
const envelope = (workflow, gate) => ({ schemaVersion: 2, correlation: correlationOf(workflow, gate), verdict: 'MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', readCompletely: true }],
  findings: [], confirmations: [], decisions: [], adversarialResults: gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [] });

test('Issue #304 an Issue convergence gate is outside its root, and the pull-request one is unchanged', () => {
  const built = helpers.buildGateExpectation(expectation('issue', 'convergence'));
  assert.equal(built.ok, false);
  assert.equal(built.error.code, 'gate_outside_root');
  const read = gateResult.validateGateResult(envelope('issue', 'convergence'), expectation('issue', 'convergence'));
  assert.equal(read.ok, false);
  assert.equal(read.error.code, 'correlation_mismatch');
  assert.match(read.error.message, /gate convergence is not a issue gate/);
  for (const gate of ['adversarial', 'decision-drift']) {
    assert.equal(helpers.buildGateExpectation(expectation('issue', gate)).ok, true, `issue ${gate}`);
    assert.equal(gateResult.validateGateResult(envelope('issue', gate), expectation('issue', gate)).ok, true, `issue ${gate} result`);
  }
  // A hand-edited Issue expectation naming convergence is refused at launch too.
  const edited = JSON.parse(JSON.stringify(helpers.buildGateExpectation(expectation('issue', 'adversarial')).data));
  edited.expected.correlation.gate = 'convergence';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i304-'));
  try {
    const expectationPath = path.join(dir, 'expectation.json');
    fs.writeFileSync(expectationPath, JSON.stringify(edited.expected));
    const launch = helpers.buildGateLaunch({ expectation: edited, expectationPath, volatile: {} });
    assert.equal(launch.ok, false);
    assert.equal(launch.error.code, 'gate_outside_root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(helpers.buildGateExpectation(expectation('pr', 'convergence')).ok, true);
  assert.equal(gateResult.validateGateResult(envelope('pr', 'convergence'), expectation('pr', 'convergence')).ok, true);
  assert.deepEqual(gateResult.ROOT_GATES, { issue: ['adversarial', 'decision-drift'], pr: ['adversarial', 'safety', 'convergence'] });
});

test('Issue #304 the convergence role declares the pull-request schema', () => {
  assert.equal(gateResult.ROLE_SCHEMAS['tidd-convergence-reviewer'], gateResult.SCHEMA);
  const line = readText('agents/tidd-convergence-reviewer.md').split('\n').find((l) => l.startsWith('outputSchema:'));
  assert.deepEqual(JSON.parse(line.slice('outputSchema:'.length).trim()), gateResult.SCHEMA);
  const body = readText('agents/tidd-convergence-reviewer.md');
  assert.ok(body.includes('The adversarial and safety gates review the same candidate after you and keep their full authority.'));
  assert.equal(body.split('\n---\n').slice(1).join('\n').includes('decision-drift'), false, 'the convergence body names no Issue gate');
  assert.match(sectionOf(readContract(), '## CL-D1 — Gate verdicts are supplied by the caller, not by agent files'), /CL-D121 later narrowed the convergence body's gate sentence to the pull-request gates under its own widening\./);
});

test('Issue #304 the Issue Skill orders Sol, then Terra, and the shared contract runs convergence on the pull-request root only', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  assert.ok(skill.includes('`tidd-adversarial-reviewer` and `tidd-drift-reviewer`. If one does not resolve, apply the shared `BLOCKED` rule in `gate-contract.md`. The Issue root runs no convergence stage (CL-D121).'));
  assert.ok(skill.includes('specification → tidd-adversarial-reviewer gate → disposition/revision → Sol MERGE → tidd-drift-reviewer gate → disposition/revision → Terra MERGE\n'));
  assert.ok(skill.includes('The Issue root runs no convergence stage (CL-D121): Sol is the first gate on every Issue route.'));
  assert.ok(skill.includes('The fixed review order is Sol-before-Terra.'));
  // The Issue Skill names convergence only in the two CL-D121 sentences.
  assert.equal(skill.split('convergence').length - 1, 2, 'the Issue Skill keeps no convergence obligation');
  const shared = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '## Convergence stage (CL-D62)');
  assert.ok(shared.includes('before the adversarial gate on the pull-request root only: PR `convergence → adversarial → safety`. The Issue root runs no convergence stage, and its order is `adversarial → decision-drift` (CL-D121).'));
  assert.ok(shared.includes('the cap is 3 per run on PR review-only and 5 on exact autofix'));
  assert.ok(shared.includes('as reported by the runner, and a pull-request status block also the counts of convergence and adversarial invocations.'));
  const readme = readText('README.md');
  assert.ok(readme.includes('`/tidd-issue` preflights `tidd-adversarial-reviewer` and `tidd-drift-reviewer`;'));
  assert.ok(readme.includes('runs before the adversarial gate on the pull-request root (the Issue root runs none, CL-D121)'));
  // The two phrases CL-D62 retired are current again in the Issue Skill only, by this decision.
  const allowed = readJson('test/records/workflow-vocabulary.json').retiredPhrases.filter((retired) => retired.allowedIn);
  assert.deepEqual(allowed.map((retired) => [retired.pattern, retired.allowedIn, retired.allowedBy]), [
    ['restarts? at Sol\\b', ['skills/closed-loop-issue/SKILL.md'], 'CL-D121'],
    ['The fixed review order is Sol-before-Terra\\.', ['skills/closed-loop-issue/SKILL.md'], 'CL-D121'],
  ]);
});

test('Issue #304 CL-D121 records the decision, and CL-D62 and CL-D120 say what it narrows', () => {
  const contract = readContract();
  const record = sectionOf(contract, '## CL-D121 — The Issue root runs no convergence stage');
  assert.ok(record, 'CL-D121 must exist');
  for (const field of ['*Decision ID:* CL-D121', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), field);
  assert.match(record, /issues\/190#issuecomment-6243884276/);
  assert.deepEqual(readManifest().clauses.filter((clause) => clause.marker === 'CL-D121').map((clause) => clause.id), ['CL-D121-record', 'CL-D121-schema', 'CL-D121-skill', 'CL-D121-contract']);
  assert.ok(readManifest().clauses.every((clause) => clause.id !== 'CL-D62-issue'), 'the Issue convergence clause is gone');
  assert.match(sectionOf(contract, '## CL-D62 — A non-authoritative convergence stage runs before the adversarial gate'), /#304 later took the stage off the Issue root \(CL-D121\)/);
  assert.match(contract, /#304 later took `convergence` out of the Issue root's gates and gave `tidd-convergence-reviewer` the pull-request schema \(CL-D121\)\./);
  assert.match(sectionOf(contract, '## CL-D32 — Scope-freeze approval stays inside the candidate transaction (historical; retired by CL-D123)'), /#304 later took it off that route \(CL-D121\): the Issue root runs no convergence stage\./);
  assert.match(sectionOf(contract, '## CL-D63 — Deterministic agreement checks are the first review layer'), /CL-D121 later allowed two phrases CL-D62 retired in the Issue Skill by file \(`allowedIn`, `allowedBy`\), beside the line qualification\./);
});

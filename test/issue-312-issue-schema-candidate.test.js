'use strict';

// Issue #312 (CL-D124). #310 (CL-D123) retired the Issue candidate route, so the Issue root never sets
// `candidateIdentity`, yet gate-result schema version 2 still declared it on the Issue correlation and the Issue finding
// record, and the validator still compared it. The owner chose to remove it from version 2; version 1 keeps its rule.

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, issueCorrelationOf } = require('./helpers');

const OID = 'a'.repeat(40), SHA = '1'.repeat(64), CANDIDATE = 'f'.repeat(64);
const EVIDENCE = [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }];
const prCorrelation = (gate) => ({ repository: 'o/r', number: 312, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) });
const issueCorrelation = (gate, over = {}) => issueCorrelationOf(prCorrelation(gate), over);
const expectation = (workflow, correlation) => ({ workflow, correlation, assignedFindings: [], requiredEvidence: EVIDENCE });
const envelope = (correlation, over = {}) => ({
  schemaVersion: 2, correlation, verdict: 'MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', readCompletely: true }],
  findings: [], confirmations: [], decisions: [],
  adversarialResults: correlation.gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [],
  ...over,
});
const issueFinding = (correlation, workflowRecord) => ({
  findingId: 'ADV-312-SHAPE', origin: 'fresh', gate: correlation.gate, issueSpec: correlation.issueSpec, raisedAgainstFingerprint: SHA,
  severity: 'Major', anchoring: 'criterion-anchored', anchor: 'AC1', proposedDisposition: 'fixed',
  evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending', workflowRecord,
});
function refused(result, code, message) {
  assert.equal(result.ok, false, `must be refused: ${message}`);
  assert.equal(result.error.code, code, JSON.stringify(result.error));
  if (message) assert.match(result.error.message, message);
}

test('Issue #312 the version-2 Issue shapes declare no candidateIdentity', () => {
  assert.deepEqual(Object.keys(gateResult.correlationSchema('issue').properties).sort(), ['contractInput', 'gate', 'invocation', 'issueSpec', 'lifecycle', 'number', 'repository', 'snapshotFingerprint']);
  for (const variant of gateResult.ISSUE_SCHEMA.properties.findings.items.anyOf) {
    assert.deepEqual(Object.keys(variant.properties.workflowRecord.properties).sort(), ['revisedPassage', 'snapshotAssignment']);
  }
  // AC3: the roles that review the Issue root decode that shape (their agent files equal ROLE_SCHEMAS, CL-D90).
  const { ROLE_SCHEMAS } = gateResult;
  assert.equal(ROLE_SCHEMAS['tidd-drift-reviewer'], gateResult.ISSUE_SCHEMA);
  assert.equal(readText('agents/tidd-drift-reviewer.md').includes('candidateIdentity'), false);
  const union = ROLE_SCHEMAS['tidd-adversarial-reviewer'];
  assert.deepEqual(union.properties.correlation.anyOf[1], gateResult.correlationSchema('issue'));
  assert.equal(JSON.stringify(union.properties.correlation.anyOf[1]).includes('candidateIdentity'), false);
});

test('Issue #312 a version-2 Issue result or expectation carrying candidateIdentity is refused', () => {
  const corr = issueCorrelation('adversarial');
  const e = expectation('issue', corr);
  assert.equal(gateResult.validateGateResult(envelope(corr), e).ok, true);
  const found = gateResult.validateGateResult(envelope(corr, { verdict: 'FIX BEFORE MERGE', findings: [issueFinding(corr, { revisedPassage: 'r', snapshotAssignment: 's' })] }), e);
  assert.equal(found.ok, true, JSON.stringify(found.error));
  refused(gateResult.validateGateResult(envelope({ ...corr, candidateIdentity: CANDIDATE }), e), 'unknown_field', /correlation: unknown candidateIdentity/);
  refused(gateResult.validateGateResult(envelope(corr, { verdict: 'FIX BEFORE MERGE', findings: [issueFinding(corr, { revisedPassage: 'r', snapshotAssignment: 's', candidateIdentity: CANDIDATE })] }), e), 'unknown_field', /unknown candidateIdentity/);
  const carrying = expectation('issue', { ...corr, candidateIdentity: CANDIDATE });
  refused(helpers.buildGateExpectation(carrying), 'unknown_field', /unknown candidateIdentity/);
  refused(gateResult.validateGateResult(envelope(corr), carrying), 'unknown_field', /unknown candidateIdentity/);
});

test('Issue #312 version 1 keeps its Issue record rule', () => {
  const pr = { ...prCorrelation('sol') };
  const v1 = { ...envelope(pr), schemaVersion: 1, adversarialResults: [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] };
  const { issueSpec: _omit, ...v1Finding } = { ...issueFinding({ gate: 'sol', issueSpec: SHA }, { revisedPassage: 'r', snapshotAssignment: 's' }), findingId: 'SOL-312-A', headOid: OID };
  const e = expectation('issue', pr);
  refused(gateResult.validateGateResult({ ...v1, verdict: 'FIX BEFORE MERGE', findings: [v1Finding] }, e), 'finding_records_invalid', /Issue record/);
  const named = { ...v1Finding, workflowRecord: { ...v1Finding.workflowRecord, candidateIdentity: 'candidate-1' } };
  const ok = gateResult.validateGateResult({ ...v1, verdict: 'FIX BEFORE MERGE', findings: [named] }, e);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});

test('Issue #312 the helper, the Skill, the gate contract and the records describe the version-2 Issue shape without a candidate', () => {
  const source = readText('skills/closed-loop-pr/helpers/gate-result.js');
  assert.equal(source.includes('while a candidate is under review'), false);
  assert.equal(source.includes("[...ISSUE_CORR_REQ, 'candidateIdentity']"), false);
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  assert.equal(skill.includes('never sets `candidateIdentity`'), false);
  assert.ok(skill.includes('The Issue correlation and finding record have no candidate field (CL-D124).'));
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.equal(/candidate identity exactly when|`candidateIdentity` exactly while/.test(contract), false);
  assert.ok(contract.includes('Issue records carry only candidate identity, fixed revised passage, and snapshot assignment under version 1; under version 2 they carry no candidate identity (CL-D124).'));
  assert.ok(contract.includes('The Issue correlation names none of them and no candidate (CL-D124); it carries `issueSpec`, a finding or confirmation binds to its gate by `issueSpec`, and an Issue record names no candidate.'));
  const record = readText('contract/CL-D124.md');
  assert.match(record, /^## CL-D124 — The version-2 Issue schema has no candidate field\n\*\*Clauses:\*\* CL-D124-record, CL-D124-schema, CL-D124-skill, CL-D124-contract\n/);
  assert.match(readText('CONTRACT.md'), /- \[contract\/CL-D124\.md\]\(contract\/CL-D124\.md\) — The version-2 Issue schema has no candidate field\n/);
  for (const id of ['CL-D120', 'CL-D123']) {
    assert.match(readText(`contract/${id}.md`), /\n#312 later removed `candidateIdentity` from the version-2 Issue schema \(CL-D124\)\.\n$/, id);
  }
});

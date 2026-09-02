'use strict';

// Issue #79 (CL-D47) — the fresh-finding namespace is derived, never supplied. The validator
// always computed the prefix from the correlation and compared the caller's hand-copied
// `freshFindingIdPrefix` against its own derivation, so the field's only power was to be
// wrong: in the field it destroyed completed verdicts, including a Sol MERGE, over a copy
// mismatch that carried no information.
//
// TDD provenance: recorded with the focused command below at 0 passes and 3 failures — the
// derivation and rejection scenarios are behavioral RED against the comparing validator, and
// the authority scenario is compile/contract RED against the supplying prose. That local
// output is not claimed as repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGateResult } = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, sectionOf } = require('./helpers');

const OID = 'a'.repeat(40);
const SHA = '1'.repeat(64);
function correlation() {
  return {
    repository: 'tetsuh/pi-tidd-agents', number: 79, baseOid: 'b'.repeat(40),
    headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'fix/issue-79-derived-prefix',
    headOid: OID, lifecycle: 'open', draft: false, gate: 'sol', invocation: 1,
    contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64),
  };
}
function result(overrides = {}) {
  return {
    schemaVersion: 1, correlation: correlation(), verdict: 'MERGE',
    evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }],
    findings: [], confirmations: [], decisions: [],
    adversarialResults: [{ claim: 'derived prefix', searched: 'the validator', outcome: 'no-counterexample', evidence: 'complete' }],
    ...overrides,
  };
}
function expected(overrides = {}) {
  return {
    correlation: correlation(), workflow: 'pr', assignedFindings: [],
    requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }],
    ...overrides,
  };
}
function freshFinding(findingId) {
  return {
    findingId, origin: 'fresh', gate: 'sol', headOid: OID, raisedAgainstFingerprint: SHA,
    severity: 'Major', anchoring: 'criterion-anchored',
    proposedDisposition: 'fixed', anchor: 'AC-TDD', proposedIssueTitle: 'n/a',
    evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', validationEvidence: 'v',
    transport: 'pending',
    workflowRecord: {
      sourceKind: 'gate', sourceId: findingId, authorIdentity: 'tidd-adversarial-reviewer', authorType: 'Agent',
      observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'narrowed',
    },
  };
}

test('Issue #79 a gate result validates with no prefix input, and fresh findings still bind to the derived namespace', () => {
  const zeroFresh = validateGateResult(result(), expected());
  assert.equal(zeroFresh.ok, true, JSON.stringify(zeroFresh.error ?? {}));

  const good = validateGateResult(result({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding('SOL-79-DERIVED')] }), expected());
  assert.equal(good.ok, true, JSON.stringify(good.error ?? {}));

  const wrong = validateGateResult(result({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding('TERRA-79-DERIVED')] }), expected());
  assert.equal(wrong.ok, false, 'a fresh finding outside the derived namespace must still fail closed');
});

test('Issue #79 supplying the retired field is rejected, right or wrong alike', () => {
  for (const value of ['SOL-79-', 'TERRA-79-', 'FRESH-', '']) {
    const rejected = validateGateResult(result(), expected({ freshFindingIdPrefix: value }));
    assert.equal(rejected.ok, false, `${JSON.stringify(value)} must be rejected`);
    assert.equal(rejected.error.code, 'invalid_request');
    assert.match(rejected.error.message, /freshFindingIdPrefix is derived/);
  }
});

test('Issue #79 the shared contract says derived, not supplied', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.doesNotMatch(contract, /fresh finding namespace whose nonempty suffix matches/);
  assert.match(contract, /the fresh finding namespace is derived, never supplied/);
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D47 — The fresh-finding namespace is derived, never supplied');
  assert.ok(decision, 'CONTRACT.md must record CL-D47');
  for (const field of ['*Decision ID:* CL-D47', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D47 must carry ${field}`);
  }
});

'use strict';

// Issue #100 PR 2 (CL-D60) — gate identities inside the structured envelope name workflow
// functions, never model families. Schema version 2 carries `adversarial`, `decision-drift`,
// and `safety`, each valid only on the root that runs it, with the fresh-finding namespaces
// `ADV-`, `DRIFT-`, and `SAFETY-` derived from them. Version 1 (`sol` / `terra`, `SOL-` /
// `TERRA-`) stays accepted verbatim for one release through an explicit version branch, with
// no cross-mapping in either direction. The packaged expectation builder ships version 2 only;
// the composition table and the reply marker accept both vocabularies for the same release.
//
// TDD provenance: recorded with `node --test test/issue-100-gate-ids-v2.test.js` at RED before
// the validator, builder, composition, marker, prose, and ceiling changes; the scenarios that
// reach the validator are behavioral RED, the prose and ceiling scenarios are compile/contract
// RED. That local output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { AUTHORITY_FILES, readText, repoPath, sectionOf } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const OID = 'a'.repeat(40);
const SHA = '1'.repeat(64);
const V2_GATES = ['adversarial', 'decision-drift', 'safety'];
const V1_GATES = ['sol', 'terra'];
const MARKER_GATES = ['sol', 'terra', 'sol+terra', 'adversarial', 'safety', 'decision-drift', 'adversarial+safety', 'adversarial+decision-drift'];

// The seven authority files measured this when CL-D60 raised the ceiling to 140,000. It is a
// historical fact about that decision, not a running total (CL-D48).
const CL_D60_BASELINE_BYTES = 128618;

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}
function correlation(gate) {
  return {
    repository: 'tetsuh/pi-tidd-agents', number: 100, baseOid: 'b'.repeat(40),
    headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'feat/issue-100-gate-ids-v2',
    headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1,
    contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64),
  };
}
function envelope(schemaVersion, gate, over = {}) {
  return {
    schemaVersion, correlation: correlation(gate), verdict: 'MERGE',
    evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }],
    findings: [], confirmations: [], decisions: [],
    adversarialResults: [{ claim: 'gate identities', searched: 'the validator', outcome: 'no-counterexample', evidence: 'complete' }],
    ...over,
  };
}
function expectation(workflow, gate) {
  return { workflow, correlation: correlation(gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] };
}
function fresh(findingId, gate, root) {
  return {
    findingId, origin: 'fresh', gate, headOid: OID, raisedAgainstFingerprint: SHA,
    severity: 'Major', anchoring: 'criterion-anchored', anchor: 'AC-GATES', proposedDisposition: 'fixed',
    evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending',
    workflowRecord: root === 'pr'
      ? { sourceKind: 'gate', sourceId: findingId, authorIdentity: 'tidd-adversarial-reviewer', authorType: 'Agent', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'narrowed' }
      : { candidateIdentity: 'candidate-1', revisedPassage: 'revised', snapshotAssignment: 'snapshot-1' },
  };
}
function withFresh(schemaVersion, gate, root, findingId) {
  return envelope(schemaVersion, gate, { verdict: 'FIX BEFORE MERGE', findings: [fresh(findingId, gate, root)] });
}
function marker(gates) {
  return helpers.createReplyMarker({
    binding: {
      repository: 'tetsuh/pi-tidd-agents', number: 100, sourceKind: 'issue_comment', sourceId: '1',
      sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/100#issuecomment-1', sourceBodySha256: SHA,
      sourceCreatedAt: '2026-09-03T00:00:00Z', sourceUpdatedAt: '2026-09-03T00:00:00Z', head: OID,
      findings: [{ findingId: 'ADV-100-GATE-IDS', disposition: 'fixed' }], gates, commit: null,
    },
    visibleBody: 'Confirming gate: adversarial at the exact head.\n',
  });
}

test("Issue #100 version 2 envelopes validate with their root's gates and reject the other root's gate", () => {
  for (const [workflow, gate] of [['pr', 'adversarial'], ['pr', 'safety'], ['issue', 'adversarial'], ['issue', 'decision-drift']]) {
    const ok = gateResult.validateGateResult(envelope(2, gate), expectation(workflow, gate));
    assert.equal(ok.ok, true, `${workflow}/${gate}: ${JSON.stringify(ok.error ?? {})}`);
    assert.equal(ok.data.correlation.gate, gate);
  }
  for (const [workflow, gate] of [['pr', 'decision-drift'], ['issue', 'safety']]) {
    const bad = gateResult.validateGateResult(envelope(2, gate), expectation(workflow, gate));
    assert.equal(bad.ok, false, `${workflow}/${gate} must be rejected`);
    assert.equal(bad.error.code, 'correlation_mismatch', `${workflow}/${gate}: ${bad.error.code}`);
  }
});

test('Issue #100 fresh findings bind to the derived version 2 namespace, never the version 1 one', () => {
  for (const [workflow, gate, id] of [['pr', 'adversarial', 'ADV-100-A'], ['pr', 'safety', 'SAFETY-100-A'], ['issue', 'adversarial', 'ADV-100-B'], ['issue', 'decision-drift', 'DRIFT-100-A']]) {
    const ok = gateResult.validateGateResult(withFresh(2, gate, workflow, id), expectation(workflow, gate));
    assert.equal(ok.ok, true, `${workflow}/${gate}/${id}: ${JSON.stringify(ok.error ?? {})}`);
  }
  for (const [workflow, gate, id] of [['pr', 'adversarial', 'SOL-100-A'], ['pr', 'safety', 'TERRA-100-A'], ['pr', 'safety', 'ADV-100-A'], ['issue', 'decision-drift', 'SAFETY-100-A']]) {
    const bad = gateResult.validateGateResult(withFresh(2, gate, workflow, id), expectation(workflow, gate));
    assert.equal(bad.ok, false, `${gate}/${id} must be rejected`);
    assert.equal(bad.error.code, 'finding_records_invalid');
    assert.match(bad.error.message, /namespace/);
  }
});

test('Issue #100 version 1 stays accepted verbatim for one release, with no cross-mapping in either direction', () => {
  for (const [workflow, gate] of [['pr', 'sol'], ['pr', 'terra'], ['issue', 'sol'], ['issue', 'terra']]) {
    const ok = gateResult.validateGateResult(envelope(1, gate), expectation(workflow, gate));
    assert.equal(ok.ok, true, `v1 ${workflow}/${gate}: ${JSON.stringify(ok.error ?? {})}`);
  }
  assert.equal(gateResult.validateGateResult(withFresh(1, 'sol', 'pr', 'SOL-100-A'), expectation('pr', 'sol')).ok, true);
  assert.equal(gateResult.validateGateResult(withFresh(1, 'sol', 'pr', 'ADV-100-A'), expectation('pr', 'sol')).error.code, 'finding_records_invalid');
  assert.equal(gateResult.validateGateResult(envelope(1, 'adversarial'), expectation('pr', 'adversarial')).error.code, 'unknown_enum', 'a v2 gate inside a v1 envelope is not mapped');
  assert.equal(gateResult.validateGateResult(envelope(2, 'sol'), expectation('pr', 'sol')).error.code, 'unknown_enum', 'a v1 gate inside a v2 envelope is not mapped');
  assert.equal(gateResult.validateGateResult(envelope(3, 'adversarial'), expectation('pr', 'adversarial')).error.code, 'unknown_version');
  // The adversarial-results duty follows the adversarial gate under each version.
  assert.equal(gateResult.validateGateResult(envelope(2, 'adversarial', { adversarialResults: [] }), expectation('pr', 'adversarial')).error.code, 'evidence_records_invalid');
  assert.equal(gateResult.validateGateResult(envelope(2, 'safety', { adversarialResults: [] }), expectation('pr', 'safety')).ok, true);
  // ADV-106-V1-VERBATIM: version 1 keeps its exact legacy diagnostic; version 2 has its own.
  const legacy = gateResult.validateGateResult(envelope(1, 'sol', { adversarialResults: [] }), expectation('pr', 'sol'));
  assert.equal(legacy.error.code, 'evidence_records_invalid');
  assert.equal(legacy.error.message, 'Sol adversarial missing', 'the version 1 diagnostic is verbatim');
  assert.equal(gateResult.validateGateResult(envelope(2, 'adversarial', { adversarialResults: [] }), expectation('pr', 'adversarial')).error.message, 'adversarial results missing');
});

test('Issue #100 the packaged expectation builder ships version 2 only', () => {
  const built = cli('build_gate_expectation', expectation('pr', 'adversarial'));
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(built.data.outputSchema.properties.schemaVersion.const, 2);
  assert.deepEqual(built.data.outputSchema.properties.correlation.properties.gate.enum, V2_GATES);
  const validated = cli('gate_result_validate', { result: envelope(2, 'adversarial'), expected: built.data.expected });
  assert.equal(validated.ok, true, JSON.stringify(validated.error));
  const legacy = cli('build_gate_expectation', expectation('pr', 'sol'));
  assert.equal(legacy.ok, false, 'the builder does not construct a version 1 expectation');
  assert.equal(legacy.error.code, 'unknown_enum');
  assert.deepEqual(gateResult.SCHEMA.properties.correlation.properties.gate.enum, V2_GATES);
  assert.deepEqual(gateResult.SCHEMAS[1].properties.correlation.properties.gate.enum, V1_GATES);
  assert.deepEqual(Object.keys(gateResult.SCHEMAS).sort(), ['1', '2']);
});

test('Issue #100 the composition table accepts both envelope versions and the reply marker parses both gate vocabularies', () => {
  for (const version of [1, 2]) assert.equal(helpers.inputShapeProblem('gate_result_validate', { result: envelope(version, 'sol'), expected: {} }), null, `version ${version}`);
  assert.notEqual(helpers.inputShapeProblem('gate_result_validate', { result: envelope(3, 'sol'), expected: {} }), null);
  for (const gates of MARKER_GATES) {
    const made = marker(gates);
    assert.equal(made.ok, true, `${gates}: ${JSON.stringify(made.error ?? {})}`);
    assert.match(made.data.marker, new RegExp(`gates=${gates.replace('+', '\\+')}(\\s|$)`));
  }
  const bad = marker('luna');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_reply_binding');
});

test('Issue #100 the shared contract, the addendum, the README, and CL-D60 record the version 2 identities', () => {
  const transport = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '### Structured gate result transport (CL-D36)');
  assert.ok(transport);
  assert.match(transport, /Gate identities \(CL-D60\): under envelope schema version 2 the gate is `adversarial` \(the Sol gate on both roots\), `decision-drift` \(the Terra gate on the Issue root\), or `safety` \(the Terra gate on the PR root\)/);
  assert.match(transport, /a version 2 envelope naming a gate outside its root fails closed/);
  assert.match(transport, /the derived fresh-finding namespaces are `ADV-<n>-`, `DRIFT-<n>-`, and `SAFETY-<n>-`/);
  assert.match(transport, /Version 1 \(`sol`, `terra`, `SOL-`, `TERRA-`\) remains accepted for one release by an explicit version branch with no cross-mapping between versions/);
  assert.match(transport, /the packaged expectation builder ships version 2 only/);
  assert.match(transport, /a publication marker names its gates in the vocabulary of the envelope it was written from, and both vocabularies parse for that release/);
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.match(addendum, /gate \(`adversarial` or `safety`; `sol` or `terra` under schema version 1\)/);
  assert.doesNotMatch(addendum, /gate \(`sol` or `terra`\)/);
  const readme = readText('README.md');
  assert.match(readme, /structured envelope \(schema version 2\) are `adversarial`, `decision-drift`, and `safety`/);
  assert.match(readme, /Sol and Terra remain the gate nicknames in prose/);
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D60 — Gate identities name workflow functions; schema version 2');
  assert.ok(record, 'CL-D60 must exist');
  for (const field of ['*Decision ID:* CL-D60', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D60 must carry ${field}`);
  assert.match(record, /issues\/100#issuecomment-5526064661/);
  assert.match(record, /`ADV-`, `DRIFT-`, and `SAFETY-`/);
  assert.match(record, /no cross-mapping/);
  assert.match(record, /128,000 to 140,000/);
  assert.match(sectionOf(contract, '## CL-D36 — Formal gate results travel as a strict structured envelope'), /CL-D60 later versioned the gate identities/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D60').map((clause) => clause.id).sort(), ['CL-D60-identities', 'CL-D60-tests']);
});

test('Issue #100 CL-D60 raises the authority ceiling once, with the headroom property asserted at the raise', () => {
  for (const file of ['test/package.test.js', 'test/issue-73-authority-budget.test.js', 'test/issue-87-authority-floor.test.js', 'test/issue-87-addendum-split.test.js']) {
    const text = readText(file);
    assert.match(text, /assert\.ok\(total < 140000,/, `${file} asserts the raised ceiling`);
    assert.equal(text.includes('total < 128000'), false, `${file}: the superseded ceiling must not survive`);
  }
  // CL-D43's own raise-time property stays as the historical fact it is.
  assert.match(readText('test/issue-73-authority-budget.test.js'), /128000 - RAISE_BASELINE_BYTES > 8000/);
  assert.ok(CL_D60_BASELINE_BYTES > 128000, 'the raise was taken because the graph could not fit under 128,000');
  assert.ok(140000 - CL_D60_BASELINE_BYTES > 8000, `the raise left only ${140000 - CL_D60_BASELINE_BYTES} bytes`);
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 140000, `authority files total ${total}`);
});

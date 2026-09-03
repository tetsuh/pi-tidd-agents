'use strict';

// Issue #37 / CL-D1, CL-D2, CL-D29, CL-D30: Sol and Terra return a strict structured
// result envelope. The parent's authority is that envelope, never a regex over Markdown.
// Compatibility option 2: the human report still ends with the final-line verdict token,
// but it is not what the parent parses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { readText, readJson, repoPath, sectionOf } = require('./helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const PR_AUTOFIX_ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';

const VERDICTS = ['MERGE', 'FIX BEFORE MERGE', 'NEEDS DECISION'];

const correlation = () => ({
  repository: 'tetsuh/pi-tidd-agents',
  number: 56,
  baseOid: '8f68df92b1c8f8dfaa22edf1c425975c36b01fa7',
  headRepository: 'tetsuh/pi-tidd-agents',
  headBranch: 'feat/issue-37-gate-result-envelope',
  headOid: 'fb4e160480cead933e57b04336ce2ab81e303dba',
  lifecycle: 'open',
  draft: false,
  gate: 'sol',
  invocation: 1,
  contractInput: 'a'.repeat(64),
  snapshotFingerprint: 'b'.repeat(64),
});
const finding = (over = {}) => ({
  findingId: 'SOL-56-001',
  origin: 'assigned',
  blockerKey: 'example-key',
  gate: 'sol',
  headOid: correlation().headOid,
  raisedAgainstFingerprint: 'e'.repeat(64),
  severity: 'Blocker',
  anchoring: 'criterion-anchored',
  anchor: 'acceptance criterion 3',
  proposedDisposition: 'fixed',
  evidence: 'cited counterexample',
  impact: 'the guard fails closed',
  rationale: 'the anchor is falsified',
  correction: 'narrow the row',
  validationEvidence: 'npm test 400/400',
  transport: 'pending',
  workflowRecord: {
    sourceKind: 'gate', sourceId: 'SOL-56-001', authorIdentity: 'tidd-adversarial-reviewer', authorType: 'Agent',
    observedHeadOid: correlation().headOid, fingerprint: '1'.repeat(64),
    semanticFingerprint: '2'.repeat(64), correctiveChange: 'narrowed the row',
  },
  ...over,
});
const confirmation = (over = {}) => ({ findingId: 'SOL-56-001', gate: 'sol', headOid: correlation().headOid, confirmation: 'confirmed', evidence: 'reread at head', ...over });
const decision = (over = {}) => ({
  decisionId: 'DEC-56-001', kind: 'contract', targetAndRevision: 'PR #56 at head', question: 'q',
  options: 'a or b', recommendation: 'a', rationale: 'r', validity: 'this revision', status: 'pending', ...over,
});
const attestation = (over = {}) => ({ source: 'skills/closed-loop-pr/SKILL.md', kind: 'file', identity: 'f'.repeat(64), readCompletely: true, ...over });
const adversarial = (over = {}) => ({ claim: 'all required authority was read', searched: 'the supplied files', outcome: 'no-counterexample', evidence: 'complete attestation set', ...over });
const envelope = (over = {}) => ({
  schemaVersion: 1,
  correlation: correlation(),
  verdict: 'MERGE',
  evidenceRead: [attestation()],
  findings: [],
  confirmations: [],
  decisions: [],
  adversarialResults: [adversarial()],
  ...over,
});
const expect = (over = {}) => {
  const expectedCorrelation = over.correlation || correlation();
  return {
    correlation: expectedCorrelation,
    workflow: 'pr',
    assignedFindings: [],
    requiredEvidence: [{ source: attestation().source, kind: attestation().kind, identity: attestation().identity }],
    ...over,
  };
};
const freshFinding = (over = {}) => {
  const value = finding({ findingId: 'SOL-56-NEW-001', origin: 'fresh', validationEvidence: undefined, ...over });
  delete value.blockerKey;
  for (const [key, entry] of Object.entries(value)) if (entry === undefined) delete value[key];
  return value;
};

test('Issue #37 the packaged schema is closed and pins the exact verdict vocabulary', () => {
  const schema = gateResult.SCHEMA;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'the envelope schema must be closed');
  assert.deepEqual(schema.properties.verdict.enum, VERDICTS, 'CL-D1 vocabulary must be preserved exactly');
  assert.deepEqual(schema.properties.correlation.required.slice().sort(), Object.keys(correlation()).sort());
  assert.equal(schema.properties.correlation.additionalProperties, false);
  for (const key of ['schemaVersion', 'correlation', 'verdict']) assert.ok(schema.required.includes(key));
});

test('Issue #37 a valid Sol and a valid Terra envelope round-trip', () => {
  for (const gate of ['sol', 'terra']) {
    const value = envelope({ correlation: { ...correlation(), gate } });
    const result = gateResult.validateGateResult(value, expect({ correlation: value.correlation }));
    assert.equal(result.ok, true, `valid ${gate} envelope rejected: ${JSON.stringify(result.error)}`);
    assert.equal(result.data.verdict, 'MERGE');
  }
});

test('Issue #37 unknown fields, unknown versions, and unknown enums fail closed', () => {
  // Pin the exact code per case. Asserting only `ok:false` passed for the wrong reason:
  // with the unknown-field guard removed, an unknown key made the walker dereference an
  // absent subschema and the resulting TypeError surfaced as generic `gate_result_invalid`.
  const cases = [
    ['unknown_field', envelope({ extra: true }), 'unknown_field'],
    ['unknown_version', envelope({ schemaVersion: 2 }), 'unknown_version'],
    ['unknown_verdict', envelope({ verdict: 'LGTM' }), 'unknown_enum'],
    ['unknown_gate', envelope({ correlation: { ...correlation(), gate: 'luna' } }), 'unknown_enum'],
    ['unknown_nested_field', envelope({ evidenceRead: [{ ...attestation(), extra: true }] }), 'unknown_field'],
  ];
  for (const [label, value, code] of cases) {
    const result = gateResult.validateGateResult(value, expect());
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.error.code, code, `${label} must be rejected as ${code}, not ${result.error.code}`);
  }
});

test('Issue #37 correlation must match the expected invocation exactly', () => {
  for (const [field, value] of [['headOid', 'c'.repeat(40)], ['gate', 'terra'], ['invocation', 2], ['snapshotFingerprint', 'd'.repeat(64)], ['number', 99]]) {
    const supplied = envelope({ correlation: { ...correlation(), [field]: value } });
    const result = gateResult.validateGateResult(supplied, expect());
    assert.equal(result.ok, false, `a mismatched ${field} must be rejected`);
    assert.equal(result.error.code, 'correlation_mismatch');
  }
});

test('Issue #37 evidence attestations are parent-bound and Sol adversarial results are mandatory', () => {
  const cases = [
    ['omitted evidence', envelope({ evidenceRead: [] })],
    ['incomplete evidence', envelope({ evidenceRead: [attestation({ readCompletely: false })] })],
    ['duplicate evidence', envelope({ evidenceRead: [attestation(), attestation()] })],
    ['unexpected evidence', envelope({ evidenceRead: [attestation({ identity: 'x' })] })],
    ['empty Sol adversarial results', envelope({ adversarialResults: [] })],
  ];
  for (const [label, value] of cases) {
    const result = gateResult.validateGateResult(value, expect());
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'evidence_records_invalid');
  }
  const missingExpected = gateResult.validateGateResult(envelope(), { ...expect(), requiredEvidence: [] });
  assert.equal(missingExpected.ok, false);
  assert.equal(missingExpected.error.code, 'invalid_request');
  const typedExpected = gateResult.validateGateResult(envelope(), { ...expect(), assignedFindings: [{ findingId: 1, blockerKey: 'key' }] });
  assert.equal(typedExpected.ok, false, 'parent assignment fields must be nonempty strings');
  assert.equal(typedExpected.error.code, 'invalid_request');
  const typedEvidence = gateResult.validateGateResult(envelope(), { ...expect(), requiredEvidence: [{ source: 1, kind: 'file', identity: 'x' }] });
  assert.equal(typedEvidence.ok, false, 'parent evidence identity fields must be nonempty strings');
  assert.equal(typedEvidence.error.code, 'invalid_request');
  // CL-D47: the namespace is derived, so any supplied copy — right or wrong — is rejected.
  const suppliedNamespace = gateResult.validateGateResult(envelope(), { ...expect(), freshFindingIdPrefix: 'SOL-999-' });
  assert.equal(suppliedNamespace.ok, false);
  assert.equal(suppliedNamespace.error.code, 'invalid_request');
  for (const value of [
    envelope({ adversarialResults: [adversarial({ outcome: 'counterexample' })] }),
    envelope({ adversarialResults: [adversarial({ outcome: 'unavailable-evidence', findingId: 'SOL-56-404' })] }),
    envelope({ adversarialResults: [adversarial({ findingId: 'SOL-56-001' })] }),
  ]) {
    const result = gateResult.validateGateResult(value, expect());
    assert.equal(result.ok, false, 'material adversarial results and finding linkage must agree');
    assert.equal(result.error.code, 'evidence_records_invalid');
  }
  const linked = freshFinding();
  const linkedEnvelope = envelope({ verdict: 'FIX BEFORE MERGE', findings: [linked], adversarialResults: [adversarial({ outcome: 'counterexample', findingId: linked.findingId })] });
  assert.equal(gateResult.validateGateResult(linkedEnvelope, expect()).ok, true, 'a material adversarial result may link to its finding');
  const assigned = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  const contradictedFix = envelope({ findings: [finding()], confirmations: [confirmation()], adversarialResults: [adversarial({ outcome: 'counterexample', findingId: 'SOL-56-001' })] });
  const contradictedResult = gateResult.validateGateResult(contradictedFix, assigned);
  assert.equal(contradictedResult.ok, false, 'material evidence cannot coexist with a confirmed fixed finding under MERGE');
  assert.equal(contradictedResult.error.code, 'verdict_inconsistent');
});

test('Issue #37 permits distinct assigned findings to share a normalized blockerKey', () => {
  const sharedKey = 'normalized-shared-key';
  const first = finding({ blockerKey: sharedKey });
  const second = finding({ findingId: 'SOL-56-002', blockerKey: sharedKey,
    workflowRecord: { ...finding().workflowRecord, sourceId: 'SOL-56-002', semanticFingerprint: '3'.repeat(64) } });
  const expected = expect({ assignedFindings: [
    { findingId: first.findingId, blockerKey: sharedKey },
    { findingId: second.findingId, blockerKey: sharedKey },
  ] });
  const result = gateResult.validateGateResult(envelope({ findings: [first, second], confirmations: [
    confirmation(), confirmation({ findingId: second.findingId }),
  ] }), expected);
  assert.equal(result.ok, true, 'distinct source findings may normalize to one parent blockerKey');
});

test('Issue #37 exactly one confirmation record is required per assigned finding', () => {
  const expected = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  const withFinding = (confirmations) => envelope({ verdict: 'MERGE', findings: [finding()], confirmations });

  assert.equal(gateResult.validateGateResult(withFinding([confirmation()]), expected).ok, true);
  for (const [label, confirmations] of [
    ['missing', []],
    ['duplicate', [confirmation(), confirmation()]],
    ['unexpected', [confirmation(), confirmation({ findingId: 'SOL-56-999' })]],
  ]) {
    const result = gateResult.validateGateResult(withFinding(confirmations), expected);
    assert.equal(result.ok, false, `${label} confirmation must be rejected`);
    assert.equal(result.error.code, 'confirmation_records_invalid');
  }
});

test('Issue #37 verdict-dependent invariants hold', () => {
  const expected = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  // MERGE has no unresolved blocker.
  const unresolved = envelope({ verdict: 'MERGE', findings: [finding()], confirmations: [confirmation({ confirmation: 'rejected' })] });
  const mergeResult = gateResult.validateGateResult(unresolved, expected);
  assert.equal(mergeResult.ok, false, 'MERGE with an unresolved blocker must be rejected');
  assert.equal(mergeResult.error.code, 'verdict_inconsistent');

  // NEEDS DECISION has exactly one complete pending decision.
  const empty = expect();
  assert.equal(gateResult.validateGateResult(envelope({ verdict: 'NEEDS DECISION', decisions: [decision()] }), empty).ok, true);
  for (const [label, decisions] of [['none', []], ['two', [decision(), decision({ decisionId: 'DEC-56-002' })]]]) {
    const result = gateResult.validateGateResult(envelope({ verdict: 'NEEDS DECISION', decisions }), empty);
    assert.equal(result.ok, false, `NEEDS DECISION with ${label} pending decisions must be rejected`);
    assert.equal(result.error.code, 'verdict_inconsistent');
  }
});

// SOL-57-002/SOL-57-006: assigned confirmations stay strict while fresh findings remain reportable.
test('Issue #37 assigned findings are bound and fresh findings round-trip separately', () => {
  const assigned = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  const omittedResult = gateResult.validateGateResult(envelope(), assigned);
  assert.equal(omittedResult.ok, false, 'a result omitting an assigned finding must be rejected');
  assert.match(omittedResult.error.message, /omits assigned finding SOL-56-001/);

  const initialFresh = envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding()] });
  assert.equal(gateResult.validateGateResult(initialFresh, expect()).ok, true, 'an initial gate must transport a fresh finding without a confirmation');
  const suppliedPrefix = gateResult.validateGateResult(initialFresh, { ...expect(), freshFindingIdPrefix: 'FRESH-' });
  assert.equal(suppliedPrefix.ok, false, 'a supplied namespace is rejected; the derived one governs');
  assert.equal(suppliedPrefix.error.code, 'invalid_request');
  const mixed = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(), freshFinding()], confirmations: [confirmation()] });
  assert.equal(gateResult.validateGateResult(mixed, assigned).ok, true, 'assigned and fresh findings must round-trip together');

  const falselyAssigned = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations: [confirmation()] });
  const falseResult = gateResult.validateGateResult(falselyAssigned, expect());
  assert.equal(falseResult.ok, false, 'a model cannot label an unassigned ID as assigned');
  assert.match(falseResult.error.message, /assigned tuple mismatch/);
  const forgedTuple = envelope({ verdict: 'MERGE', findings: [finding({ blockerKey: 'forged' })], confirmations: [confirmation()] });
  const forgedResult = gateResult.validateGateResult(forgedTuple, assigned);
  assert.equal(forgedResult.ok, false, 'the complete parent-owned finding tuple must match');
  assert.match(forgedResult.error.message, /assigned tuple mismatch/);

  for (const [label, value] of [
    ['assigned ID mislabeled fresh', envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ findingId: 'SOL-56-001' })] })],
    ['fresh ID outside namespace', envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ findingId: 'TERRA-56-NEW-001' })] })],
    ['fresh ID equal to namespace', envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ findingId: 'SOL-56-' })] })],
    ['fresh ID with whitespace', envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ findingId: 'SOL-56-NEW 001' })] })],
    ['fresh finding assigning blockerKey', envelope({ verdict: 'FIX BEFORE MERGE', findings: [{ ...freshFinding(), blockerKey: 'forged' }] })],
  ]) {
    const result = gateResult.validateGateResult(value, label.startsWith('assigned') ? assigned : expect());
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'finding_records_invalid');
  }

  for (const suffix of ['_X', '.X', '-X']) {
    const value = envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ findingId: `SOL-56-${suffix}` })] });
    assert.equal(gateResult.validateGateResult(value, expect()).ok, true, `declared suffix ${suffix} must be accepted`);
  }
  for (const [label, over] of [['wrong gate', { gate: 'terra' }], ['stale head', { headOid: 'c'.repeat(40) }]]) {
    const value = envelope({ verdict: 'MERGE', findings: [finding()], confirmations: [confirmation(over)] });
    const result = gateResult.validateGateResult(value, assigned);
    assert.equal(result.ok, false, `a confirmation with a ${label} must be rejected`);
    assert.equal(result.error.code, 'confirmation_records_invalid');
  }
});

test('Issue #37 workflow records round-trip with root-specific completeness checks', () => {
  const assigned = [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }];
  const issueRecord = { candidateIdentity: 'candidate-sha256', revisedPassage: 'revised requirement', snapshotAssignment: 'snapshot C pending' };
  const issueFinding = finding({ workflowRecord: issueRecord });
  const issueExpected = expect({ workflow: 'issue', assignedFindings: assigned });
  assert.equal(gateResult.validateGateResult(envelope({ findings: [issueFinding], confirmations: [confirmation()] }), issueExpected).ok, true);
  for (const [label, workflowRecord] of [
    ['Issue candidate missing', { revisedPassage: 'x', snapshotAssignment: 'C' }],
    ['Issue fixed passage missing', { candidateIdentity: 'c', snapshotAssignment: 'C' }],
    ['Issue carrying PR fields', { candidateIdentity: 'c', revisedPassage: 'x', snapshotAssignment: 'C', sourceKind: 'gate' }],
  ]) {
    const result = gateResult.validateGateResult(envelope({ findings: [finding({ workflowRecord })], confirmations: [confirmation()] }), issueExpected);
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'finding_records_invalid');
  }
  const freshIssue = freshFinding({ workflowRecord: { candidateIdentity: 'c', snapshotAssignment: 'C' } });
  const freshIssueResult = gateResult.validateGateResult(envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshIssue] }), expect({ workflow: 'issue' }));
  assert.equal(freshIssueResult.ok, false, 'fresh fixed Issue records need a proposed revised passage');
  for (const key of ['sourceKind', 'sourceId', 'observedHeadOid', 'fingerprint', 'semanticFingerprint', 'authorIdentity', 'authorType']) {
    const workflowRecord = { ...finding().workflowRecord }; delete workflowRecord[key];
    const result = gateResult.validateGateResult(envelope({ findings: [finding({ workflowRecord })], confirmations: [confirmation()] }), expect({ assignedFindings: assigned }));
    assert.equal(result.ok, false, `PR ${key} must be required`);
    assert.equal(result.error.code, 'finding_records_invalid');
  }
  const crossRoot = { ...finding().workflowRecord, candidateIdentity: 'not allowed' };
  assert.equal(gateResult.validateGateResult(envelope({ findings: [finding({ workflowRecord: crossRoot })], confirmations: [confirmation()] }), expect({ assignedFindings: assigned })).ok, false);
  const freshPrRecord = { ...freshFinding().workflowRecord }; delete freshPrRecord.correctiveChange;
  assert.equal(gateResult.validateGateResult(envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding({ workflowRecord: freshPrRecord })] }), expect()).ok, false, 'fresh fixed PR records need a proposed corrective change');
  const unknownSource = { ...finding().workflowRecord, sourceKind: 'unknown' };
  const unknownResult = gateResult.validateGateResult(envelope({ findings: [finding({ workflowRecord: unknownSource })], confirmations: [confirmation()] }), expect({ assignedFindings: assigned }));
  assert.equal(unknownResult.ok, false, 'unknown PR source kinds fail closed');
  const sourceRecord = (sourceKind) => {
    const record = { ...finding().workflowRecord, sourceKind };
    if (sourceKind !== 'gate') Object.assign(record, { sourceUrl: 'https://example.test/source', bodyDigest: '3'.repeat(64), createdAt: '2026-08-17T00:00:00Z', updatedAt: '2026-08-17T00:01:00Z' });
    if (['review', 'inline-comment'].includes(sourceKind)) record.reviewCommitOid = correlation().headOid;
    if (sourceKind === 'inline-comment') Object.assign(record, { path: 'src/example.js', line: 7 });
    return record;
  };
  for (const sourceKind of ['gate', 'body', 'issue-comment', 'review', 'inline-comment', 'check', 'status']) {
    const value = envelope({ findings: [finding({ workflowRecord: sourceRecord(sourceKind) })], confirmations: [confirmation()] });
    assert.equal(gateResult.validateGateResult(value, expect({ assignedFindings: assigned })).ok, true, `complete ${sourceKind} source must round-trip`);
  }
  for (const [sourceKind, key] of [['body', 'sourceUrl'], ['issue-comment', 'bodyDigest'], ['review', 'reviewCommitOid'], ['inline-comment', 'path'], ['inline-comment', 'line'], ['check', 'createdAt'], ['status', 'updatedAt']]) {
    const record = sourceRecord(sourceKind); delete record[key];
    const value = envelope({ findings: [finding({ workflowRecord: record })], confirmations: [confirmation()] });
    assert.equal(gateResult.validateGateResult(value, expect({ assignedFindings: assigned })).ok, false, `${sourceKind} must require ${key}`);
  }
  const incompatibleGate = sourceRecord('gate'); incompatibleGate.sourceUrl = 'https://example.test/source';
  assert.equal(gateResult.validateGateResult(envelope({ findings: [finding({ workflowRecord: incompatibleGate })], confirmations: [confirmation()] }), expect({ assignedFindings: assigned })).ok, false, 'source variants reject incompatible fields');
});

// SOL-57-003: record schemas carry the AC-DISPOSITION, AC-DECISION, CL-D29, and CL-D2 fields.
test('Issue #37 record schemas are closed and carry their contract fields', () => {
  const { findings, confirmations, decisions, evidenceRead, adversarialResults } = gateResult.SCHEMA.properties;
  for (const key of ['origin', 'raisedAgainstFingerprint', 'impact', 'rationale', 'correction', 'transport']) {
    assert.ok(findings.items.required.includes(key), `AC-DISPOSITION field ${key} must be required on a finding`);
  }
  for (const key of ['blockerKey', 'validationEvidence', 'anchoring', 'outOfScope', 'anchor', 'proposedIssueTitle']) {
    assert.ok(Object.hasOwn(findings.items.properties, key), `conditional AC-DISPOSITION/CL-D34 field ${key} must exist`);
  }
  for (const key of ['decisionId', 'kind', 'targetAndRevision', 'question', 'options', 'recommendation', 'rationale', 'validity', 'status']) {
    assert.ok(decisions.items.required.includes(key), `AC-DECISION field ${key} must be required`);
  }
  assert.ok(Object.hasOwn(decisions.items.properties, 'ownerChoice'), 'AC-DECISION owner choice must exist');
  assert.ok(confirmations.items.required.includes('evidence'));
  // evidenceRead is a closed attestation record, not a bare string list.
  assert.equal(evidenceRead.items.type, 'object');
  assert.equal(evidenceRead.items.additionalProperties, false);
  assert.deepEqual(evidenceRead.items.required.slice().sort(), ['identity', 'kind', 'readCompletely', 'source']);
  assert.equal(adversarialResults.items.additionalProperties, false);
  assert.ok(adversarialResults.items.required.includes('evidence'));
  assert.ok(Object.hasOwn(adversarialResults.items.properties, 'findingId'));
  assert.deepEqual(adversarialResults.items.properties.outcome.enum, ['counterexample', 'unavailable-evidence', 'no-counterexample']);
  const stringEvidence = gateResult.validateGateResult(envelope({ evidenceRead: ['skills/closed-loop-pr/SKILL.md'] }), expect());
  assert.equal(stringEvidence.ok, false, 'a bare string evidence entry must be rejected');
});

// SOL-57-003 conditional obligations, enforced outside the flat grammar.
test('Issue #37 conditional finding obligations are enforced', () => {
  const assigned = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  const withFinding = (over) => envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(over)], confirmations: [confirmation()] });
  for (const [label, over] of [
    ['criterion-anchored without an anchor', { anchor: undefined }],
    ['follow-up without a proposed issue title', { anchoring: 'follow-up', anchor: undefined, proposedIssueTitle: undefined }],
    ['finding without a correction', { correction: undefined }],
    ['fixed assigned finding without validation evidence', { validationEvidence: undefined }],
    ['finding with both anchoring and out-of-scope labels', { outOfScope: true }],
    ['finding without anchoring or out-of-scope label', { anchoring: undefined }],
    ['Blocker reword', { anchoring: 'reword' }],
    ['deferred reword', { severity: 'Major', anchoring: 'reword', proposedDisposition: 'deferred' }],
    ['a finding naming another gate', { gate: 'terra' }],
    ['a finding naming another head', { headOid: 'c'.repeat(40) }],
  ]) {
    const value = withFinding(over);
    // `undefined` spreads as an absent key only after an explicit delete.
    for (const [key, entry] of Object.entries(value.findings[0])) if (entry === undefined) delete value.findings[0][key];
    const result = gateResult.validateGateResult(value, assigned);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.error.code, label === 'finding without a correction' ? 'schema_invalid' : 'finding_records_invalid');
  }
});

// SOL-57-004: the verdict matrix rejects the states the contract cannot represent.
test('Issue #37 the verdict matrix rejects inconsistent states', () => {
  const assigned = expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] });
  const minorUnresolved = envelope({ verdict: 'MERGE', findings: [finding({ severity: 'Minor' })], confirmations: [confirmation({ confirmation: 'unverifiable' })] });
  const minor = gateResult.validateGateResult(minorUnresolved, assigned);
  assert.equal(minor.ok, false, 'an unresolved Minor finding must still block MERGE');
  assert.equal(minor.error.code, 'verdict_inconsistent');

  const emptyFix = gateResult.validateGateResult(envelope({ verdict: 'FIX BEFORE MERGE' }), expect());
  assert.equal(emptyFix.ok, false, 'FIX BEFORE MERGE with no finding must be rejected');
  assert.equal(emptyFix.error.code, 'verdict_inconsistent');

  const fixWithPending = envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding()], decisions: [decision()] });
  const pendingResult = gateResult.validateGateResult(fixWithPending, expect());
  assert.equal(pendingResult.ok, false, 'a pending decision requires NEEDS DECISION');
  assert.equal(pendingResult.error.code, 'verdict_inconsistent');

  const recordedWithoutChoice = envelope({ decisions: [decision({ status: 'recorded' })] });
  assert.equal(gateResult.validateGateResult(recordedWithoutChoice, expect()).ok, false, 'a recorded decision must carry the owner choice');
  const duplicateDecision = envelope({ verdict: 'NEEDS DECISION', decisions: [decision(), decision()] });
  assert.equal(gateResult.validateGateResult(duplicateDecision, expect()).ok, false, 'decision IDs must be unique');
  const pendingWithChoice = envelope({ verdict: 'NEEDS DECISION', decisions: [decision({ ownerChoice: 'a' })] });
  assert.equal(gateResult.validateGateResult(pendingWithChoice, expect()).ok, false, 'a pending decision cannot carry an owner choice');

  const ownerFinding = freshFinding({ proposedDisposition: 'needs-owner-decision' });
  const ownerAsMerge = envelope({ findings: [ownerFinding] });
  assert.equal(gateResult.validateGateResult(ownerAsMerge, expect()).ok, false, 'needs-owner-decision cannot validate as MERGE');
  const ownerAsFix = envelope({ verdict: 'FIX BEFORE MERGE', findings: [ownerFinding] });
  assert.equal(gateResult.validateGateResult(ownerAsFix, expect()).ok, false, 'needs-owner-decision cannot validate as FIX');
  const ownerDecision = envelope({ verdict: 'NEEDS DECISION', findings: [ownerFinding], decisions: [decision()] });
  assert.equal(gateResult.validateGateResult(ownerDecision, expect()).ok, true, 'needs-owner-decision must correlate with one pending decision');

  const followUp = freshFinding({ severity: 'Major', anchoring: 'follow-up', proposedIssueTitle: 'Track the cooperative race', proposedDisposition: 'deferred' });
  assert.equal(gateResult.validateGateResult(envelope({ findings: [followUp] }), expect()).ok, true, 'a deferred follow-up is non-blocking');
  const confirmedReword = finding({ severity: 'Major', anchoring: 'reword' });
  assert.equal(gateResult.validateGateResult(envelope({ findings: [confirmedReword], confirmations: [confirmation()] }), assigned).ok, true, 'a confirmed fixed reword is non-blocking');
  const residual = freshFinding({ severity: 'Minor', anchoring: undefined, outOfScope: true, proposedDisposition: 'deferred' });
  assert.equal(gateResult.validateGateResult(envelope({ findings: [residual] }), expect()).ok, true, 'an out-of-scope residual is representable and non-blocking');
  const residualEvidence = envelope({ findings: [residual], adversarialResults: [adversarial({ outcome: 'counterexample', findingId: residual.findingId })] });
  assert.equal(gateResult.validateGateResult(residualEvidence, expect()).ok, true, 'CL-D34 keeps a linked out-of-scope counterexample non-blocking');
  for (const [label, entry] of [
    ['Blocker follow-up', freshFinding({ anchoring: 'follow-up', proposedIssueTitle: 'Follow up', proposedDisposition: 'deferred' })],
    ['non-deferred follow-up', freshFinding({ severity: 'Major', anchoring: 'follow-up', proposedIssueTitle: 'Follow up' })],
    ['Major out-of-scope', freshFinding({ severity: 'Major', anchoring: undefined, outOfScope: true, proposedDisposition: 'deferred' })],
    ['owner-blocking out-of-scope', freshFinding({ severity: 'Minor', anchoring: undefined, outOfScope: true, proposedDisposition: 'needs-owner-decision' })],
  ]) {
    const result = gateResult.validateGateResult(envelope({ findings: [entry] }), expect());
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'finding_records_invalid');
  }
});

test('Issue #37 packaged CLI accepts mixed findings and exits nonzero on forged fresh identity', () => {
  const request = (value) => ({ version: 1, operation: 'gate_result_validate', data: { result: value, expected: expect({ assignedFindings: [{ findingId: 'SOL-56-001', blockerKey: 'example-key' }] }) } });
  const mixed = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(), freshFinding()], confirmations: [confirmation()] });
  const success = spawnSync(process.execPath, [repoPath('skills/closed-loop-pr/helpers/cli.js')], { input: JSON.stringify(request(mixed)), encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const parsed = JSON.parse(success.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.findings.length, 2);
  assert.equal(parsed.data.adversarialResults.length, 1);

  const forged = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(), { ...freshFinding(), blockerKey: 'forged' }], confirmations: [confirmation()] });
  const failure = spawnSync(process.execPath, [repoPath('skills/closed-loop-pr/helpers/cli.js')], { input: JSON.stringify(request(forged)), encoding: 'utf8' });
  assert.notEqual(failure.status, 0);
  const error = JSON.parse(failure.stdout);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'finding_records_invalid');
});

test('Issue #37 findings separate assigned identity, fresh identity, and the out-of-scope residual label', () => {
  const record = gateResult.SCHEMA.properties.findings.items;
  assert.equal(record.additionalProperties, false);
  assert.equal(record.properties.workflowRecord.additionalProperties, false);
  for (const key of ['candidateIdentity', 'revisedPassage', 'snapshotAssignment', 'sourceKind', 'sourceId', 'sourceUrl', 'authorIdentity', 'authorType', 'bodyDigest', 'createdAt', 'updatedAt', 'reviewCommitOid', 'path', 'line', 'observedHeadOid', 'fingerprint', 'semanticFingerprint', 'correctiveChange', 'replyUrl']) assert.ok(Object.hasOwn(record.properties.workflowRecord.properties, key), `workflow record must represent ${key}`);
  for (const key of ['findingId', 'origin', 'gate', 'headOid', 'severity', 'proposedDisposition', 'evidence', 'correction']) {
    assert.ok(record.required.includes(key), `finding record must require ${key}`);
  }
  assert.ok(!record.required.includes('blockerKey'), 'fresh findings receive blockerKey only after parent intake');
  assert.ok(!record.required.includes('anchoring'), 'out-of-scope stays outside the three anchoring classes');
  assert.deepEqual(record.properties.origin.enum, ['assigned', 'fresh']);
  assert.deepEqual(record.properties.anchoring.enum, ['criterion-anchored', 'reword', 'follow-up']);
  assert.equal(record.properties.outOfScope.type, 'boolean');
  assert.deepEqual(record.properties.severity.enum, ['Blocker', 'Major', 'Minor']);
});

test('Issue #37 the shared gate contract requires the structured transport for both roots', () => {
  const shared = readText(GATE_CONTRACT);
  const section = sectionOf(shared, '### Structured gate result transport (CL-D36)');
  assert.ok(section, 'CL-D36 must own the transport rule in the shared gate contract, not one mode reference');
  assert.match(section, /Every formal Sol and Terra invocation in both workflow roots/);
  assert.match(section, /`outputSchema`/);
  assert.match(section, /every Issue, PR review-only, and exact-autofix route passes the envelope/);
  assert.match(section, /packaged `gate_result_validate` before reading any field/);
  assert.match(section, /`outputSchema` alone is insufficient/);
  assert.match(section, /parent's verdict, correlation, finding, confirmation, and decision authority/);
  assert.match(section, /never parse those fields from Markdown/i);
  assert.match(section, /final-line token `MERGE \| FIX BEFORE MERGE \| NEEDS DECISION`/);
  assert.match(section, /complete assigned `\{findingId, blockerKey\}` tuples/);
  assert.match(section, /the fresh finding namespace is derived, never supplied/);
  assert.match(section, /after validated intake[^.]*assigns `blockerKey`/);
  assert.match(section, /exact required evidence-attestation set/);
  assert.match(section, /Issue records carry only candidate identity, fixed revised passage, and snapshot assignment/);
  assert.match(section, /PR records select `gate \| body \| issue-comment \| review \| inline-comment \| check \| status`/);
  assert.match(section, /material evidence cannot simultaneously confirm that finding as fixed/);
  assert.match(section, /without weakening CL-D34's explicitly non-blocking follow-up\/out-of-scope classes/);
  assert.match(section, /Sol returns at least one complete adversarial-result record/);
  assert.match(section, /semantic-validation[^.]*tool failure that consumes no counter and is never a verdict/);
  for (const root of ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/SKILL.md']) assert.match(readText(root), /\.\.\/closed-loop-shared\/references\/gate-contract\.md/, `${root} must load the shared validator binding`);
  const autofix = (readText(PR_AUTOFIX) + '\n' + readText(PR_AUTOFIX_ADDENDUM));
  assert.match(autofix, /`gate_result_validate`/, 'the exact-autofix invocation map must retain the operation');
  assert.doesNotMatch(autofix, /outputSchema` alone is insufficient/, 'the normative all-route rule must not be restated by one mode');
});

test('Issue #37 CONTRACT.md records CL-D36 and the raised authority baseline', () => {
  const contract = readText('CONTRACT.md');
  const section = sectionOf(contract, '## CL-D36 — Formal gate results travel as a strict structured envelope');
  assert.ok(section, 'CL-D36 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D36-transport, CL-D36-validator, CL-D36-baseline$/m);
  assert.match(section, /^\*Decision ID:\* CL-D36$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#37/);
  assert.match(section, /both workflow roots/);
  assert.match(section, /human report[^.]*final-line verdict token/);
  assert.match(section, /112,000/);
  assert.match(section, /108,000/);
  assert.match(section, /agents\/\*\*` stays byte-identical/);
  assert.match(section, /assigned confirmations from fresh findings/);
  assert.match(section, /DEC-PR57-FRESH-FINDING-001/);
  assert.match(section, /exact live response `Aで進めて`/);
  assert.match(section, /fresh findings use a parent-scoped ID namespace/);
  assert.match(section, /DEC-PR57-COMPLETE-RESULT-002/);
  assert.match(section, /exact live response `Aで続けて`/);
  assert.match(section, /parent-owned `\{findingId, blockerKey\}` tuples/);
  assert.match(section, /nonempty fresh-ID suffix matching `\[A-Z0-9\._-\]\+`/);
  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D36').map((clause) => clause.id).sort(), ['CL-D36-baseline', 'CL-D36-transport', 'CL-D36-validator']);
});

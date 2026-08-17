'use strict';

// Issue #37 / CL-D1, CL-D2, CL-D29, CL-D30: Sol and Terra return a strict structured
// result envelope. The parent's authority is that envelope, never a regex over Markdown.
// Compatibility option 2: the human report still ends with the final-line verdict token,
// but it is not what the parent parses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { readText, readJson, repoPath } = require('./helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';

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
    assignedFindingIds: [],
    freshFindingIdPrefix: `${expectedCorrelation.gate === 'sol' ? 'SOL' : 'TERRA'}-${expectedCorrelation.number}-`,
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
  const cases = [
    ['unknown_field', envelope({ extra: true })],
    ['unknown_version', envelope({ schemaVersion: 2 })],
    ['unknown_verdict', envelope({ verdict: 'LGTM' })],
    ['unknown_gate', envelope({ correlation: { ...correlation(), gate: 'luna' } })],
  ];
  for (const [label, value] of cases) {
    const result = gateResult.validateGateResult(value, expect());
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(typeof result.error.code, 'string');
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
  const wrongNamespace = gateResult.validateGateResult(envelope(), { ...expect(), freshFindingIdPrefix: 'SOL-999-' });
  assert.equal(wrongNamespace.ok, false);
  assert.equal(wrongNamespace.error.code, 'invalid_request');
});

test('Issue #37 exactly one confirmation record is required per assigned finding', () => {
  const expected = expect({ assignedFindingIds: ['SOL-56-001'] });
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
  const expected = expect({ assignedFindingIds: ['SOL-56-001'] });
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
  const assigned = expect({ assignedFindingIds: ['SOL-56-001'] });
  const omittedResult = gateResult.validateGateResult(envelope(), assigned);
  assert.equal(omittedResult.ok, false, 'a result omitting an assigned finding must be rejected');
  assert.match(omittedResult.error.message, /omits assigned finding SOL-56-001/);

  const initialFresh = envelope({ verdict: 'FIX BEFORE MERGE', findings: [freshFinding()] });
  assert.equal(gateResult.validateGateResult(initialFresh, expect()).ok, true, 'an initial gate must transport a fresh finding without a confirmation');
  const wrongPrefix = gateResult.validateGateResult(initialFresh, { ...expect(), freshFindingIdPrefix: 'FRESH-' });
  assert.equal(wrongPrefix.ok, false, 'the namespace must be derived from gate and target number');
  assert.equal(wrongPrefix.error.code, 'invalid_request');
  const mixed = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(), freshFinding()], confirmations: [confirmation()] });
  assert.equal(gateResult.validateGateResult(mixed, assigned).ok, true, 'assigned and fresh findings must round-trip together');

  const falselyAssigned = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations: [confirmation()] });
  const falseResult = gateResult.validateGateResult(falselyAssigned, expect());
  assert.equal(falseResult.ok, false, 'a model cannot label an unassigned ID as assigned');
  assert.match(falseResult.error.message, /falsely labels unassigned finding/);

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

  for (const [label, over] of [['wrong gate', { gate: 'terra' }], ['stale head', { headOid: 'c'.repeat(40) }]]) {
    const value = envelope({ verdict: 'MERGE', findings: [finding()], confirmations: [confirmation(over)] });
    const result = gateResult.validateGateResult(value, assigned);
    assert.equal(result.ok, false, `a confirmation with a ${label} must be rejected`);
    assert.equal(result.error.code, 'confirmation_records_invalid');
  }
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
  assert.deepEqual(adversarialResults.items.properties.outcome.enum, ['counterexample', 'unavailable-evidence', 'no-counterexample']);
  const stringEvidence = gateResult.validateGateResult(envelope({ evidenceRead: ['skills/closed-loop-pr/SKILL.md'] }), expect());
  assert.equal(stringEvidence.ok, false, 'a bare string evidence entry must be rejected');
});

// SOL-57-003 conditional obligations, enforced outside the flat grammar.
test('Issue #37 conditional finding obligations are enforced', () => {
  const assigned = expect({ assignedFindingIds: ['SOL-56-001'] });
  const withFinding = (over) => envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding(over)], confirmations: [confirmation()] });
  for (const [label, over] of [
    ['criterion-anchored without an anchor', { anchor: undefined }],
    ['follow-up without a proposed issue title', { anchoring: 'follow-up', anchor: undefined, proposedIssueTitle: undefined }],
    ['finding without a correction', { correction: undefined }],
    ['fixed assigned finding without validation evidence', { validationEvidence: undefined }],
    ['finding with both anchoring and out-of-scope labels', { outOfScope: true }],
    ['finding without anchoring or out-of-scope label', { anchoring: undefined }],
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
  const assigned = expect({ assignedFindingIds: ['SOL-56-001'] });
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
  const residual = freshFinding({ severity: 'Minor', anchoring: undefined, outOfScope: true, proposedDisposition: 'deferred' });
  assert.equal(gateResult.validateGateResult(envelope({ findings: [residual] }), expect()).ok, true, 'an out-of-scope residual is representable and non-blocking');
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
  const request = (value) => ({ version: 1, operation: 'gate_result_validate', data: { result: value, expected: expect({ assignedFindingIds: ['SOL-56-001'] }) } });
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
  assert.match(section, /sole verdict, correlation, finding, confirmation, and decision authority/);
  assert.match(section, /never parse a verdict, correlation field, or finding record out of Markdown/i);
  assert.match(section, /still ends with the required final-line verdict token/);
  assert.match(section, /MERGE \| FIX BEFORE MERGE \| NEEDS DECISION/);
  assert.match(section, /parent supplies its own assigned finding set/);
  assert.match(section, /fresh finding namespace/);
  assert.match(section, /after intake[^.]*assigns `blockerKey`/);
  assert.match(section, /exact required evidence-attestation set/);
  assert.match(section, /Sol must return at least one complete adversarial-result record/);
  assert.match(section, /structured-output startup, schema-validation, or transport failure is a tool failure that consumes no counter and is never a verdict/);
  // The rule lives in one place; the mode reference binds only the packaged operation.
  const autofix = readText(PR_AUTOFIX);
  assert.match(autofix, /`gate_result_validate`/, 'the packaged validator must stay bound in the invocation map');
  assert.doesNotMatch(autofix, /sole verdict, correlation, finding, confirmation, and decision authority/, 'the normative rule must not be restated in the mode reference');
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
  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D36').map((clause) => clause.id).sort(), ['CL-D36-baseline', 'CL-D36-transport', 'CL-D36-validator']);
});

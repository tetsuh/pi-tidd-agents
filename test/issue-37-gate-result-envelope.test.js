'use strict';

// Issue #37 / CL-D1, CL-D2, CL-D29, CL-D30: Sol and Terra return a strict structured
// result envelope. The parent's authority is that envelope, never a regex over Markdown.
// Compatibility option 2: the human report still ends with the final-line verdict token,
// but it is not what the parent parses.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson } = require('./helpers');
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
const envelope = (over = {}) => ({
  schemaVersion: 1,
  correlation: correlation(),
  verdict: 'MERGE',
  evidenceRead: [attestation()],
  findings: [],
  confirmations: [],
  decisions: [],
  adversarialResults: [],
  ...over,
});
const expect = (over = {}) => ({ correlation: correlation(), assignedFindingIds: [], ...over });

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

test('Issue #37 exactly one confirmation record is required per assigned finding', () => {
  const expected = expect({ assignedFindingIds: ['SOL-56-001'] });
  const withFinding = (confirmations) => envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations });

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

// SOL-57-002: the assigned set is the parent's, and confirmations are bound to gate and head.
test('Issue #37 the parent supplies the assigned finding set and confirmations are gate/head bound', () => {
  const assigned = expect({ assignedFindingIds: ['SOL-56-001'] });
  const omitted = envelope({ verdict: 'MERGE' });
  const omittedResult = gateResult.validateGateResult(omitted, assigned);
  assert.equal(omittedResult.ok, false, 'a result omitting an assigned finding must be rejected');
  assert.match(omittedResult.error.message, /omits assigned finding SOL-56-001/);

  const unassigned = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations: [confirmation()] });
  const unassignedResult = gateResult.validateGateResult(unassigned, expect());
  assert.equal(unassignedResult.ok, false, 'a result reporting an unassigned finding must be rejected');
  assert.match(unassignedResult.error.message, /reports unassigned finding SOL-56-001/);

  for (const [label, over] of [['wrong gate', { gate: 'terra' }], ['stale head', { headOid: 'c'.repeat(40) }]]) {
    const value = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations: [confirmation(over)] });
    const result = gateResult.validateGateResult(value, assigned);
    assert.equal(result.ok, false, `a confirmation with a ${label} must be rejected`);
    assert.equal(result.error.code, 'confirmation_records_invalid');
  }
});

// SOL-57-003: record schemas carry the AC-DISPOSITION, AC-DECISION, CL-D29, and CL-D2 fields.
test('Issue #37 record schemas are closed and carry their contract fields', () => {
  const { findings, confirmations, decisions, evidenceRead, adversarialResults } = gateResult.SCHEMA.properties;
  for (const key of ['raisedAgainstFingerprint', 'impact', 'rationale', 'transport']) {
    assert.ok(findings.items.required.includes(key), `AC-DISPOSITION field ${key} must be required on a finding`);
  }
  for (const key of ['correction', 'validationEvidence', 'anchor', 'proposedIssueTitle']) {
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
    ['fixed without a correction', { correction: undefined }],
    ['fixed without validation evidence', { validationEvidence: undefined }],
    ['a finding naming another gate', { gate: 'terra' }],
    ['a finding naming another head', { headOid: 'c'.repeat(40) }],
  ]) {
    const value = withFinding(over);
    // `undefined` spreads as an absent key only after an explicit delete.
    for (const [key, entry] of Object.entries(value.findings[0])) if (entry === undefined) delete value.findings[0][key];
    const result = gateResult.validateGateResult(value, assigned);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.error.code, 'finding_records_invalid');
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

  const fixWithPending = envelope({ verdict: 'FIX BEFORE MERGE', findings: [finding()], confirmations: [confirmation()], decisions: [decision()] });
  const pendingResult = gateResult.validateGateResult(fixWithPending, assigned);
  assert.equal(pendingResult.ok, false, 'a pending decision requires NEEDS DECISION');
  assert.equal(pendingResult.error.code, 'verdict_inconsistent');

  const recordedWithoutChoice = envelope({ decisions: [decision({ status: 'recorded' })] });
  assert.equal(gateResult.validateGateResult(recordedWithoutChoice, expect()).ok, false, 'a recorded decision must carry the owner choice');
  const pendingWithChoice = envelope({ verdict: 'NEEDS DECISION', decisions: [decision({ ownerChoice: 'a' })] });
  assert.equal(gateResult.validateGateResult(pendingWithChoice, expect()).ok, false, 'a pending decision cannot carry an owner choice');
});

test('Issue #37 findings carry their CL-D34 anchoring class and CL-D30 record fields', () => {
  const record = gateResult.SCHEMA.properties.findings.items;
  assert.equal(record.additionalProperties, false);
  for (const key of ['findingId', 'blockerKey', 'gate', 'headOid', 'severity', 'anchoring', 'proposedDisposition', 'evidence']) {
    assert.ok(record.required.includes(key), `finding record must require ${key}`);
  }
  assert.deepEqual(record.properties.anchoring.enum, ['criterion-anchored', 'reword', 'follow-up']);
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
  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D36').map((clause) => clause.id).sort(), ['CL-D36-baseline', 'CL-D36-transport', 'CL-D36-validator']);
});

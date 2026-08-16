'use strict';

// Issue #37 / CL-D1, CL-D2, CL-D29, CL-D30: Sol and Terra return a strict structured
// result envelope. The parent's authority is that envelope, never a regex over Markdown.
// Compatibility option 2: the human report still ends with the final-line verdict token,
// but it is not what the parent parses.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText } = require('./helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
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
  severity: 'Blocker',
  anchoring: 'criterion-anchored',
  anchor: 'acceptance criterion 3',
  proposedDisposition: 'fixed',
  evidence: 'cited counterexample',
  ...over,
});
const confirmation = (over = {}) => ({ findingId: 'SOL-56-001', gate: 'sol', headOid: correlation().headOid, confirmation: 'confirmed', ...over });
const envelope = (over = {}) => ({
  schemaVersion: 1,
  correlation: correlation(),
  verdict: 'MERGE',
  evidenceRead: ['skills/closed-loop-pr/SKILL.md'],
  findings: [],
  confirmations: [],
  decisions: [],
  adversarialResults: [],
  ...over,
});

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
    const result = gateResult.validateGateResult(value, { correlation: value.correlation });
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
    const result = gateResult.validateGateResult(value, { correlation: correlation() });
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(typeof result.error.code, 'string');
  }
});

test('Issue #37 correlation must match the expected invocation exactly', () => {
  for (const [field, value] of [['headOid', 'c'.repeat(40)], ['gate', 'terra'], ['invocation', 2], ['snapshotFingerprint', 'd'.repeat(64)], ['number', 99]]) {
    const supplied = envelope({ correlation: { ...correlation(), [field]: value } });
    const result = gateResult.validateGateResult(supplied, { correlation: correlation() });
    assert.equal(result.ok, false, `a mismatched ${field} must be rejected`);
    assert.equal(result.error.code, 'correlation_mismatch');
  }
});

test('Issue #37 exactly one confirmation record is required per assigned finding', () => {
  const expected = { correlation: correlation() };
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
  const expected = { correlation: correlation() };
  // MERGE has no unresolved blocker.
  const unresolved = envelope({ verdict: 'MERGE', findings: [finding()], confirmations: [confirmation({ confirmation: 'rejected' })] });
  const mergeResult = gateResult.validateGateResult(unresolved, expected);
  assert.equal(mergeResult.ok, false, 'MERGE with an unresolved blocker must be rejected');
  assert.equal(mergeResult.error.code, 'verdict_inconsistent');

  // NEEDS DECISION has exactly one complete pending decision.
  const decision = { decisionId: 'DEC-56-001', question: 'q', options: 'a or b', recommendation: 'a', status: 'pending' };
  assert.equal(gateResult.validateGateResult(envelope({ verdict: 'NEEDS DECISION', decisions: [decision] }), expected).ok, true);
  for (const [label, decisions] of [['none', []], ['two', [decision, { ...decision, decisionId: 'DEC-56-002' }]]]) {
    const result = gateResult.validateGateResult(envelope({ verdict: 'NEEDS DECISION', decisions }), expected);
    assert.equal(result.ok, false, `NEEDS DECISION with ${label} pending decisions must be rejected`);
    assert.equal(result.error.code, 'verdict_inconsistent');
  }
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

test('Issue #37 the contract requires the structured envelope and keeps the human final line', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /`gate_result_validate`/, 'the packaged validator must be bound to a phase in the invocation map');
  assert.match(text, /The structured envelope is the parent's sole verdict and correlation authority/);
  assert.match(text, /never parse a verdict, correlation field, or finding record out of Markdown/i);
  assert.match(text, /human-readable report[^.]*still ends with the required final-line verdict token/i);
  // A schema-validation or structured-output failure stays a tool failure under the rule that
  // already governs malformed output; Issue #34 remains free to relax it later.
  assert.match(text, /structured-output startup, schema-validation, or transport failure is a tool failure that consumes no counter and is never a verdict/);
});

'use strict';

// Issue #162 — the convergence gate returned a criterion-anchored finding without `anchor` (and, earlier, a finding
// without `anchoring`). The CL-D36 schema admitted both, so structured-output decoding produced them, and the packaged
// validator then refused the result and the run ended. Four observations, the last on exact-autofix attempt 2 on
// PR #183. Owner choice B: the schema states the validator's per-finding classification rules as `anyOf` variants, so
// decoding cannot produce these results. The owner's second part, one counted re-invocation of a refused result, moves
// to the deterministic driver of #191 rather than into prose (direction of 2026-09-27).
//
// TDD provenance: behavioural RED — the schema admits the refused findings before the change.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA, validateGateResult } = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText } = require('./helpers');

// A small JSON Schema evaluator for the keywords the gate schema uses, standing in for the provider's decoding:
// what it accepts is what a schema-constrained model can emit.
function admits(schema, value) {
  if (schema.anyOf) return schema.anyOf.some((variant) => admits(variant, value));
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
      if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
      return Object.entries(value).every(([key, item]) => !schema.properties[key] || admits(schema.properties[key], item));
    }
    case 'array': return Array.isArray(value) && value.every((item) => admits(schema.items, item));
    case 'string': return typeof value === 'string' && (!schema.minLength || value.length >= schema.minLength) && (!schema.pattern || new RegExp(schema.pattern).test(value));
    case 'integer': return Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum);
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

const OID = 'a'.repeat(40), FP = 'f'.repeat(64);
const record = { sourceKind: 'gate', sourceId: 'x', authorIdentity: 'x', authorType: 'x', observedHeadOid: OID, fingerprint: FP, semanticFingerprint: FP, correctiveChange: 'c' };
function finding(overrides) {
  return { findingId: 'CONV-1-X', origin: 'fresh', gate: 'convergence', headOid: OID, raisedAgainstFingerprint: FP, severity: 'Major', proposedDisposition: 'fixed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 't', workflowRecord: record, ...overrides };
}
const findingSchema = SCHEMA.properties.findings.items;

test('Issue #162 the schema admits no finding the validator refuses for its classification', () => {
  for (const [label, refused] of [
    ['anchored without anchor (PR #183 attempt 2)', finding({ anchoring: 'criterion-anchored' })],
    ['no anchoring and not out of scope (PR #149)', finding({})],
    ['reword at Blocker', finding({ anchoring: 'reword', severity: 'Blocker', proposedDisposition: 'fixed' })],
    ['reword deferred', finding({ anchoring: 'reword', proposedDisposition: 'deferred' })],
    ['follow-up without an issue title', finding({ anchoring: 'follow-up', proposedDisposition: 'deferred', severity: 'Minor' })],
    ['follow-up fixed', finding({ anchoring: 'follow-up', proposedIssueTitle: 't', proposedDisposition: 'fixed', severity: 'Minor' })],
    ['out of scope and anchored', finding({ outOfScope: true, anchoring: 'criterion-anchored', anchor: 'AC1', severity: 'Minor', proposedDisposition: 'deferred' })],
    ['out of scope at Major', finding({ outOfScope: true, severity: 'Major', proposedDisposition: 'deferred' })],
  ]) assert.equal(admits(findingSchema, refused), false, `${label}: the schema must not admit it`);
});

test('Issue #162 the schema still admits every finding shape the validator accepts', () => {
  for (const [label, accepted] of [
    ['anchored', finding({ anchoring: 'criterion-anchored', anchor: 'AC1' })],
    ['anchored, outOfScope false', finding({ anchoring: 'criterion-anchored', anchor: 'AC1', outOfScope: false })],
    ['reword accepted', finding({ anchoring: 'reword', severity: 'Minor', proposedDisposition: 'accepted-as-designed' })],
    ['follow-up', finding({ anchoring: 'follow-up', proposedIssueTitle: 't', proposedDisposition: 'deferred', severity: 'Major' })],
    ['out of scope', finding({ outOfScope: true, severity: 'Minor', proposedDisposition: 'not-applicable' })],
  ]) assert.equal(admits(findingSchema, accepted), true, `${label}: the schema must admit it`);
  // The whole envelope schema admits a real, validator-accepted result.
  const envelope = { schemaVersion: 2, correlation: { repository: 'o/r', number: 1, baseOid: OID, headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate: 'convergence', invocation: 1, contractInput: FP, snapshotFingerprint: FP }, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'README.md', kind: 'file', readCompletely: true }], findings: [finding({ anchoring: 'criterion-anchored', anchor: 'AC1' })], confirmations: [], decisions: [], adversarialResults: [] };
  assert.equal(admits(SCHEMA, envelope), true);
  const validated = validateGateResult(envelope, { workflow: 'pr', correlation: envelope.correlation, assignedFindings: [], requiredEvidence: [{ source: 'README.md', kind: 'file', identity: FP }] });
  assert.equal(validated.ok, true, JSON.stringify(validated.error));
});

test('Issue #162 the local validator keeps its codes for the refused shapes', () => {
  const base = { schemaVersion: 2, correlation: { repository: 'o/r', number: 1, baseOid: OID, headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate: 'convergence', invocation: 1, contractInput: FP, snapshotFingerprint: FP }, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'README.md', kind: 'file', readCompletely: true }], confirmations: [], decisions: [], adversarialResults: [] };
  const expected = { workflow: 'pr', correlation: base.correlation, assignedFindings: [], requiredEvidence: [{ source: 'README.md', kind: 'file', identity: FP }] };
  const refused = validateGateResult({ ...base, findings: [finding({ anchoring: 'criterion-anchored' })] }, expected);
  assert.deepEqual([refused.ok, refused.error?.code], [false, 'finding_records_invalid'], JSON.stringify(refused));
  assert.match(refused.error.message, /CONV-1-X: anchor/);
});

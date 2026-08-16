'use strict';

const { createResult, createError } = require('./protocol');

const VERDICTS = ['MERGE', 'FIX BEFORE MERGE', 'NEEDS DECISION'];
const GATES = ['sol', 'terra'];
const SEVERITIES = ['Blocker', 'Major', 'Minor'];
const ANCHORING = ['criterion-anchored', 'reword', 'follow-up'];
const DISPOSITIONS = ['fixed', 'accepted-as-designed', 'deferred', 'duplicate', 'not-applicable', 'needs-owner-decision'];
const CONFIRMATIONS = ['confirmed', 'rejected', 'unverifiable'];
const OID = { type: 'string', pattern: '^[0-9a-f]{40}(?:[0-9a-f]{24})?$' };
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const TEXT = { type: 'string', minLength: 1 };
const closed = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });

const CORRELATION = closed({
  repository: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
  number: { type: 'integer', minimum: 1 },
  baseOid: OID,
  headRepository: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
  headBranch: TEXT,
  headOid: OID,
  lifecycle: { type: 'string', enum: ['open', 'closed', 'merged'] },
  draft: { type: 'boolean' },
  gate: { type: 'string', enum: GATES },
  invocation: { type: 'integer', minimum: 1 },
  contractInput: SHA256,
  snapshotFingerprint: SHA256,
}, ['repository', 'number', 'baseOid', 'headRepository', 'headBranch', 'headOid', 'lifecycle', 'draft', 'gate', 'invocation', 'contractInput', 'snapshotFingerprint']);

const FINDING = closed({
  findingId: TEXT,
  blockerKey: TEXT,
  gate: { type: 'string', enum: GATES },
  headOid: OID,
  severity: { type: 'string', enum: SEVERITIES },
  anchoring: { type: 'string', enum: ANCHORING },
  anchor: TEXT,
  proposedDisposition: { type: 'string', enum: DISPOSITIONS },
  evidence: TEXT,
}, ['findingId', 'blockerKey', 'gate', 'headOid', 'severity', 'anchoring', 'proposedDisposition', 'evidence']);

const CONFIRMATION = closed({
  findingId: TEXT,
  gate: { type: 'string', enum: GATES },
  headOid: OID,
  confirmation: { type: 'string', enum: CONFIRMATIONS },
  evidence: TEXT,
}, ['findingId', 'gate', 'headOid', 'confirmation']);

const DECISION = closed({
  decisionId: TEXT,
  question: TEXT,
  options: TEXT,
  recommendation: TEXT,
  status: { type: 'string', enum: ['pending', 'recorded'] },
}, ['decisionId', 'question', 'options', 'recommendation', 'status']);

const ADVERSARIAL = closed({
  claim: TEXT,
  searched: TEXT,
  outcome: { type: 'string', enum: ['counterexample', 'unavailable-evidence', 'no-counterexample'] },
  evidence: TEXT,
}, ['claim', 'searched', 'outcome']);

const SCHEMA = closed({
  schemaVersion: { type: 'integer', const: 1 },
  correlation: CORRELATION,
  verdict: { type: 'string', enum: VERDICTS },
  evidenceRead: { type: 'array', items: TEXT },
  findings: { type: 'array', items: FINDING },
  confirmations: { type: 'array', items: CONFIRMATION },
  decisions: { type: 'array', items: DECISION },
  adversarialResults: { type: 'array', items: ADVERSARIAL },
}, ['schemaVersion', 'correlation', 'verdict', 'evidenceRead', 'findings', 'confirmations', 'decisions', 'adversarialResults']);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// A deliberately small closed-schema checker: the envelope grammar uses only the keywords
// declared above, so a general JSON Schema implementation would add a dependency without
// widening what this validates.
function check(schema, value, path) {
  const where = path || 'envelope';
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('schema_invalid', `${where} must be an array`);
    value.forEach((entry, index) => check(schema.items, entry, `${where}[${index}]`));
    return;
  }
  if (schema.type === 'object') {
    if (!plain(value)) fail('schema_invalid', `${where} must be an object`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail('unknown_field', `${where} has unknown field ${key}`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail('schema_invalid', `${where} is missing required field ${key}`);
    for (const [key, entry] of Object.entries(value)) check(schema.properties[key], entry, `${where}.${key}`);
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail('schema_invalid', `${where} must be an integer`);
    if (Object.hasOwn(schema, 'const') && value !== schema.const) fail('unknown_version', `${where} must equal ${schema.const}`);
    if (Object.hasOwn(schema, 'minimum') && value < schema.minimum) fail('schema_invalid', `${where} must be at least ${schema.minimum}`);
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('schema_invalid', `${where} must be a boolean`);
    return;
  }
  if (typeof value !== 'string') fail('schema_invalid', `${where} must be a string`);
  if (schema.enum && !schema.enum.includes(value)) fail('unknown_enum', `${where} must be one of ${schema.enum.join(', ')}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('schema_invalid', `${where} does not match ${schema.pattern}`);
  if (schema.minLength !== undefined && value.length < schema.minLength) fail('schema_invalid', `${where} must be non-empty`);
}

function checkCorrelation(actual, expected) {
  for (const key of CORRELATION.required) {
    if (actual[key] !== expected[key]) fail('correlation_mismatch', `correlation ${key} does not match the expected invocation`);
  }
}

// CL-D30: every gate result carries exactly one confirmation record per assigned finding.
function checkConfirmations(findings, confirmations) {
  const assigned = findings.map((entry) => entry.findingId);
  if (new Set(assigned).size !== assigned.length) fail('confirmation_records_invalid', 'findings repeat a findingId');
  const seen = new Map();
  for (const record of confirmations) {
    if (seen.has(record.findingId)) fail('confirmation_records_invalid', `duplicate confirmation for ${record.findingId}`);
    seen.set(record.findingId, record);
  }
  for (const findingId of assigned) if (!seen.has(findingId)) fail('confirmation_records_invalid', `missing confirmation for ${findingId}`);
  for (const findingId of seen.keys()) if (!assigned.includes(findingId)) fail('confirmation_records_invalid', `unexpected confirmation for ${findingId}`);
  return seen;
}

function checkVerdict(value, confirmed) {
  const unresolved = value.findings.filter((entry) => entry.severity !== 'Minor' && confirmed.get(entry.findingId).confirmation !== 'confirmed');
  const pending = value.decisions.filter((entry) => entry.status === 'pending');
  if (value.verdict === 'MERGE' && unresolved.length) fail('verdict_inconsistent', 'MERGE cannot carry an unresolved blocker');
  if (value.verdict === 'MERGE' && pending.length) fail('verdict_inconsistent', 'MERGE cannot carry a pending decision');
  if (value.verdict === 'NEEDS DECISION' && pending.length !== 1) fail('verdict_inconsistent', 'NEEDS DECISION requires exactly one pending decision');
}

function validateGateResult(value, expected) {
  try {
    check(SCHEMA, value, 'envelope');
    if (!plain(expected) || !plain(expected.correlation)) fail('invalid_request', 'expected correlation is required');
    checkCorrelation(value.correlation, expected.correlation);
    const confirmed = checkConfirmations(value.findings, value.confirmations);
    checkVerdict(value, confirmed);
    return createResult('gate_result_validate', { verdict: value.verdict, correlation: value.correlation, findings: value.findings, confirmations: value.confirmations, decisions: value.decisions });
  } catch (error) {
    return createError('gate_result_validate', error.code || 'gate_result_invalid', error.message, 'gate_result_validate');
  }
}

module.exports = { SCHEMA, VERDICTS, GATES, SEVERITIES, ANCHORING, DISPOSITIONS, CONFIRMATIONS, validateGateResult };

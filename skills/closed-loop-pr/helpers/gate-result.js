'use strict';

const { createResult, createError } = require('./protocol');

const VERDICTS = ['MERGE', 'FIX BEFORE MERGE', 'NEEDS DECISION'];
const GATES = ['sol', 'terra'];
const SEVERITIES = ['Blocker', 'Major', 'Minor'];
const ANCHORING = ['criterion-anchored', 'reword', 'follow-up'];
const DISPOSITIONS = ['fixed', 'accepted-as-designed', 'deferred', 'duplicate', 'not-applicable', 'needs-owner-decision'];
const CONFIRMATIONS = ['confirmed', 'rejected', 'unverifiable'];
const EVIDENCE_KINDS = ['file', 'git', 'github', 'snapshot'];
const ADVERSARIAL_OUTCOMES = ['counterexample', 'unavailable-evidence', 'no-counterexample'];
const OID = { type: 'string', pattern: '^[0-9a-f]{40}(?:[0-9a-f]{24})?$' };
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const TEXT = { type: 'string', minLength: 1 };
const NWO = { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' };
const closed = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });

const CORRELATION = closed({
  repository: NWO,
  number: { type: 'integer', minimum: 1 },
  baseOid: OID,
  headRepository: NWO,
  headBranch: TEXT,
  headOid: OID,
  lifecycle: { type: 'string', enum: ['open', 'closed', 'merged'] },
  draft: { type: 'boolean' },
  gate: { type: 'string', enum: GATES },
  invocation: { type: 'integer', minimum: 1 },
  contractInput: SHA256,
  snapshotFingerprint: SHA256,
}, ['repository', 'number', 'baseOid', 'headRepository', 'headBranch', 'headOid', 'lifecycle', 'draft', 'gate', 'invocation', 'contractInput', 'snapshotFingerprint']);

// AC-DISPOSITION record fields, plus the CL-D30 blockerKey/confirmation identity and the
// CL-D34 anchoring class. Conditional fields are enforced in checkFindings, not by the
// grammar, because the grammar has no dependent-required keyword.
const FINDING = closed({
  findingId: TEXT,
  blockerKey: TEXT,
  gate: { type: 'string', enum: GATES },
  headOid: OID,
  raisedAgainstFingerprint: SHA256,
  severity: { type: 'string', enum: SEVERITIES },
  anchoring: { type: 'string', enum: ANCHORING },
  anchor: TEXT,
  proposedIssueTitle: TEXT,
  proposedDisposition: { type: 'string', enum: DISPOSITIONS },
  evidence: TEXT,
  impact: TEXT,
  rationale: TEXT,
  correction: TEXT,
  validationEvidence: TEXT,
  transport: TEXT,
}, ['findingId', 'blockerKey', 'gate', 'headOid', 'raisedAgainstFingerprint', 'severity', 'anchoring', 'proposedDisposition', 'evidence', 'impact', 'rationale', 'transport']);

const CONFIRMATION = closed({
  findingId: TEXT,
  gate: { type: 'string', enum: GATES },
  headOid: OID,
  confirmation: { type: 'string', enum: CONFIRMATIONS },
  evidence: TEXT,
}, ['findingId', 'gate', 'headOid', 'confirmation', 'evidence']);

// AC-DECISION's nine canonical fields. `ownerChoice` is absent while the decision is pending.
const DECISION = closed({
  decisionId: TEXT,
  kind: TEXT,
  targetAndRevision: TEXT,
  question: TEXT,
  options: TEXT,
  recommendation: TEXT,
  ownerChoice: TEXT,
  rationale: TEXT,
  validity: TEXT,
  status: { type: 'string', enum: ['pending', 'recorded'] },
}, ['decisionId', 'kind', 'targetAndRevision', 'question', 'options', 'recommendation', 'rationale', 'validity', 'status']);

// CL-D2 requires complete reads of the supplied authority; an attestation names what was
// read and whether it was read completely, so a partial read cannot pass as a full one.
const EVIDENCE = closed({
  source: TEXT,
  kind: { type: 'string', enum: EVIDENCE_KINDS },
  identity: TEXT,
  readCompletely: { type: 'boolean' },
}, ['source', 'kind', 'identity', 'readCompletely']);

const ADVERSARIAL = closed({
  claim: TEXT,
  searched: TEXT,
  outcome: { type: 'string', enum: ADVERSARIAL_OUTCOMES },
  evidence: TEXT,
}, ['claim', 'searched', 'outcome']);

const SCHEMA = closed({
  schemaVersion: { type: 'integer', const: 1 },
  correlation: CORRELATION,
  verdict: { type: 'string', enum: VERDICTS },
  evidenceRead: { type: 'array', items: EVIDENCE },
  findings: { type: 'array', items: FINDING },
  confirmations: { type: 'array', items: CONFIRMATION },
  decisions: { type: 'array', items: DECISION },
  adversarialResults: { type: 'array', items: ADVERSARIAL },
}, ['schemaVersion', 'correlation', 'verdict', 'evidenceRead', 'findings', 'confirmations', 'decisions', 'adversarialResults']);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// A deliberately small closed-grammar checker: the envelope uses only the keywords declared
// above, so a general JSON Schema implementation would add a dependency without widening
// what this validates.
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

// Conditional record obligations that the flat grammar cannot express.
function checkFindings(findings, correlation) {
  for (const entry of findings) {
    if (entry.gate !== correlation.gate) fail('finding_records_invalid', `finding ${entry.findingId} names another gate`);
    if (entry.headOid !== correlation.headOid) fail('finding_records_invalid', `finding ${entry.findingId} names another head`);
    if (entry.anchoring === 'criterion-anchored' && !entry.anchor) fail('finding_records_invalid', `criterion-anchored finding ${entry.findingId} must name its anchor`);
    if (entry.anchoring === 'follow-up' && !entry.proposedIssueTitle) fail('finding_records_invalid', `follow-up finding ${entry.findingId} must propose an issue title`);
    if (entry.proposedDisposition === 'fixed' && !(entry.correction && entry.validationEvidence)) fail('finding_records_invalid', `fixed finding ${entry.findingId} must carry its correction and validation evidence`);
  }
}

// CL-D30: exactly one confirmation record per finding the parent assigned. The assigned set
// comes from the parent, never from the result, so an omitted assignment cannot pass.
function checkConfirmations(findings, confirmations, assigned, correlation) {
  const reported = findings.map((entry) => entry.findingId);
  if (new Set(reported).size !== reported.length) fail('confirmation_records_invalid', 'findings repeat a findingId');
  for (const findingId of assigned) if (!reported.includes(findingId)) fail('confirmation_records_invalid', `result omits assigned finding ${findingId}`);
  for (const findingId of reported) if (!assigned.includes(findingId)) fail('confirmation_records_invalid', `result reports unassigned finding ${findingId}`);

  const seen = new Map();
  for (const record of confirmations) {
    if (seen.has(record.findingId)) fail('confirmation_records_invalid', `duplicate confirmation for ${record.findingId}`);
    if (record.gate !== correlation.gate) fail('confirmation_records_invalid', `confirmation for ${record.findingId} names another gate`);
    if (record.headOid !== correlation.headOid) fail('confirmation_records_invalid', `confirmation for ${record.findingId} names a stale head`);
    seen.set(record.findingId, record);
  }
  for (const findingId of reported) if (!seen.has(findingId)) fail('confirmation_records_invalid', `missing confirmation for ${findingId}`);
  for (const findingId of seen.keys()) if (!reported.includes(findingId)) fail('confirmation_records_invalid', `unexpected confirmation for ${findingId}`);
  return seen;
}

function checkVerdict(value, confirmed) {
  const unresolved = value.findings.filter((entry) => confirmed.get(entry.findingId).confirmation !== 'confirmed');
  const pending = value.decisions.filter((entry) => entry.status === 'pending');
  for (const entry of value.decisions) {
    if (entry.status === 'recorded' && !entry.ownerChoice) fail('verdict_inconsistent', `recorded decision ${entry.decisionId} must carry the owner choice`);
    if (entry.status === 'pending' && entry.ownerChoice) fail('verdict_inconsistent', `pending decision ${entry.decisionId} cannot carry an owner choice`);
  }
  if (value.verdict === 'MERGE') {
    if (unresolved.length) fail('verdict_inconsistent', 'MERGE cannot carry an unresolved finding');
    if (pending.length) fail('verdict_inconsistent', 'MERGE cannot carry a pending decision');
  }
  if (value.verdict === 'FIX BEFORE MERGE') {
    if (!value.findings.length) fail('verdict_inconsistent', 'FIX BEFORE MERGE requires at least one finding');
    if (pending.length) fail('verdict_inconsistent', 'a pending decision requires NEEDS DECISION');
  }
  if (value.verdict === 'NEEDS DECISION' && pending.length !== 1) fail('verdict_inconsistent', 'NEEDS DECISION requires exactly one pending decision');
}

function validateGateResult(value, expected) {
  try {
    check(SCHEMA, value, 'envelope');
    if (!plain(expected) || !plain(expected.correlation)) fail('invalid_request', 'expected correlation is required');
    if (!Array.isArray(expected.assignedFindingIds) || expected.assignedFindingIds.some((id) => typeof id !== 'string' || !id)) fail('invalid_request', 'expected assignedFindingIds must be an array of non-empty strings');
    if (new Set(expected.assignedFindingIds).size !== expected.assignedFindingIds.length) fail('invalid_request', 'expected assignedFindingIds must be unique');
    checkCorrelation(value.correlation, expected.correlation);
    checkFindings(value.findings, value.correlation);
    const confirmed = checkConfirmations(value.findings, value.confirmations, expected.assignedFindingIds, value.correlation);
    checkVerdict(value, confirmed);
    return createResult('gate_result_validate', { verdict: value.verdict, correlation: value.correlation, findings: value.findings, confirmations: value.confirmations, decisions: value.decisions });
  } catch (error) {
    return createError('gate_result_validate', error.code || 'gate_result_invalid', error.message, 'gate_result_validate');
  }
}

module.exports = { SCHEMA, VERDICTS, GATES, SEVERITIES, ANCHORING, DISPOSITIONS, CONFIRMATIONS, EVIDENCE_KINDS, ADVERSARIAL_OUTCOMES, validateGateResult };

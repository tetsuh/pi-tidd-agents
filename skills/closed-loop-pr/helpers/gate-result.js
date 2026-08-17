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

// Conditional finding duties are enforced below.
const FINDING = closed({
  findingId: TEXT,
  origin: { type: 'string', enum: ['assigned', 'fresh'] },
  blockerKey: TEXT,
  gate: { type: 'string', enum: GATES },
  headOid: OID,
  raisedAgainstFingerprint: SHA256,
  severity: { type: 'string', enum: SEVERITIES },
  anchoring: { type: 'string', enum: ANCHORING },
  outOfScope: { type: 'boolean' },
  anchor: TEXT,
  proposedIssueTitle: TEXT,
  proposedDisposition: { type: 'string', enum: DISPOSITIONS },
  evidence: TEXT,
  impact: TEXT,
  rationale: TEXT,
  correction: TEXT,
  validationEvidence: TEXT,
  transport: TEXT,
}, ['findingId', 'origin', 'gate', 'headOid', 'raisedAgainstFingerprint', 'severity', 'proposedDisposition', 'evidence', 'impact', 'rationale', 'correction', 'transport']);

const CONFIRMATION = closed({ findingId: TEXT, gate: { type: 'string', enum: GATES }, headOid: OID,
  confirmation: { type: 'string', enum: CONFIRMATIONS }, evidence: TEXT },
['findingId', 'gate', 'headOid', 'confirmation', 'evidence']);
const DECISION = closed({ decisionId: TEXT, kind: TEXT, targetAndRevision: TEXT, question: TEXT,
  options: TEXT, recommendation: TEXT, ownerChoice: TEXT, rationale: TEXT, validity: TEXT,
  status: { type: 'string', enum: ['pending', 'recorded'] } },
['decisionId', 'kind', 'targetAndRevision', 'question', 'options', 'recommendation', 'rationale', 'validity', 'status']);
const EVIDENCE = closed({ source: TEXT, kind: { type: 'string', enum: EVIDENCE_KINDS }, identity: TEXT,
  readCompletely: { type: 'boolean' } }, ['source', 'kind', 'identity', 'readCompletely']);
const ADVERSARIAL = closed({ claim: TEXT, searched: TEXT,
  outcome: { type: 'string', enum: ADVERSARIAL_OUTCOMES }, evidence: TEXT },
['claim', 'searched', 'outcome', 'evidence']);

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

// Closed-grammar checker for the keywords declared above.
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
  for (const key of CORRELATION.required) if (actual[key] !== expected[key]) fail('correlation_mismatch', `correlation ${key} does not match expected`);
}

function checkEvidence(value, required) {
  const bad = (message) => fail('evidence_records_invalid', message);
  if (!Array.isArray(required) || !required.length) fail('invalid_request', 'requiredEvidence missing');
  const key = (entry) => JSON.stringify([entry.source, entry.kind, entry.identity]);
  for (const entry of required) {
    if (!plain(entry) || Object.keys(entry).length !== 3 || !['source', 'kind', 'identity'].every((field) => typeof entry[field] === 'string' && entry[field])) fail('invalid_request', 'bad requiredEvidence');
    if (!EVIDENCE_KINDS.includes(entry.kind)) fail('invalid_request', 'bad evidence kind');
  }
  const expected = required.map(key), actual = value.evidenceRead.map(key);
  if (new Set(expected).size !== expected.length) fail('invalid_request', 'duplicate requiredEvidence');
  if (new Set(actual).size !== actual.length) bad('duplicate evidence');
  if (value.evidenceRead.some((entry) => !entry.readCompletely)) bad('incomplete evidence');
  for (const identity of expected) if (!actual.includes(identity)) bad('required evidence omitted');
  for (const identity of actual) if (!expected.includes(identity)) bad('unexpected evidence');
  if (value.correlation.gate === 'sol' && !value.adversarialResults.length) bad('Sol adversarialResults missing');
}

function checkFindings(findings, correlation, assigned, freshPrefix) {
  const bad = (message) => fail('finding_records_invalid', message);
  const ids = findings.map((entry) => entry.findingId);
  if (new Set(ids).size !== ids.length) bad('duplicate findingId');
  for (const entry of findings) {
    if (entry.gate !== correlation.gate) bad(`${entry.findingId}: gate mismatch`);
    if (entry.headOid !== correlation.headOid) bad(`${entry.findingId}: head mismatch`);
    const residual = entry.outOfScope === true;
    if (residual === Boolean(entry.anchoring)) bad(`${entry.findingId}: classification mismatch`);
    if (entry.anchoring === 'criterion-anchored' && !entry.anchor) bad(`${entry.findingId}: anchor missing`);
    if (entry.anchoring === 'follow-up' && (!entry.proposedIssueTitle || entry.proposedDisposition !== 'deferred' || entry.severity === 'Blocker')) bad(`${entry.findingId}: invalid follow-up`);
    if (residual && (entry.severity !== 'Minor' || !['accepted-as-designed', 'deferred', 'not-applicable'].includes(entry.proposedDisposition))) bad(`${entry.findingId}: invalid out-of-scope`);
    if (entry.origin === 'assigned') {
      if (!assigned.includes(entry.findingId)) bad(`result falsely labels unassigned finding ${entry.findingId} as assigned`);
      if (!entry.blockerKey) bad(`${entry.findingId}: blockerKey missing`);
      if (entry.proposedDisposition === 'fixed' && !entry.validationEvidence) bad(`${entry.findingId}: validation missing`);
    } else {
      if (assigned.includes(entry.findingId)) bad(`${entry.findingId}: assigned ID is fresh`);
      const suffix = entry.findingId.slice(freshPrefix.length);
      if (!entry.findingId.startsWith(freshPrefix) || !/^[A-Z0-9][A-Z0-9._-]*$/.test(suffix)) bad(`${entry.findingId}: namespace mismatch`);
      if (entry.blockerKey) bad(`${entry.findingId}: fresh blockerKey`);
    }
  }
  for (const id of assigned) if (!findings.some((entry) => entry.findingId === id && entry.origin === 'assigned')) fail('confirmation_records_invalid', `result omits assigned finding ${id}`);
}

function checkConfirmations(findings, confirmations, assigned, correlation) {
  const bad = (message) => fail('confirmation_records_invalid', message);
  const reported = findings.filter((entry) => entry.origin === 'assigned').map((entry) => entry.findingId);
  const seen = new Map();
  for (const record of confirmations) {
    if (seen.has(record.findingId)) bad(`duplicate ${record.findingId}`);
    if (!assigned.includes(record.findingId)) bad(`unexpected ${record.findingId}`);
    if (record.gate !== correlation.gate) bad(`${record.findingId}: gate mismatch`);
    if (record.headOid !== correlation.headOid) bad(`${record.findingId}: head mismatch`);
    seen.set(record.findingId, record);
  }
  for (const id of reported) if (!seen.has(id)) bad(`missing ${id}`);
  for (const id of seen.keys()) if (!reported.includes(id)) bad(`unexpected ${id}`);
  return seen;
}

function checkVerdict(value, confirmed) {
  const bad = (message) => fail('verdict_inconsistent', message);
  const pending = value.decisions.filter((entry) => entry.status === 'pending');
  if (new Set(value.decisions.map((entry) => entry.decisionId)).size !== value.decisions.length) bad('duplicate decisionId');
  for (const entry of value.decisions) {
    if (entry.status === 'recorded' && !entry.ownerChoice) bad(`${entry.decisionId}: owner choice missing`);
    if (entry.status === 'pending' && entry.ownerChoice) bad(`${entry.decisionId}: pending choice present`);
  }
  const ownerNeeded = value.findings.some((entry) => entry.proposedDisposition === 'needs-owner-decision');
  const unresolved = value.findings.filter((entry) => entry.origin === 'assigned'
    ? confirmed.get(entry.findingId).confirmation !== 'confirmed' || entry.proposedDisposition === 'needs-owner-decision'
    : entry.outOfScope !== true && !(entry.anchoring === 'follow-up' && entry.proposedDisposition === 'deferred'));
  if (ownerNeeded && (value.verdict !== 'NEEDS DECISION' || pending.length !== 1)) bad('owner decision state mismatch');
  if (value.verdict === 'MERGE' && (unresolved.length || pending.length)) bad('MERGE has unresolved state');
  if (value.verdict === 'FIX BEFORE MERGE' && (!unresolved.length || pending.length)) bad('FIX state mismatch');
  if (value.verdict === 'NEEDS DECISION' && pending.length !== 1) bad('NEEDS DECISION count mismatch');
}

function validateGateResult(value, expected) {
  try {
    check(SCHEMA, value, 'envelope');
    if (!plain(expected) || !plain(expected.correlation)) fail('invalid_request', 'correlation missing');
    if (!Array.isArray(expected.assignedFindingIds) || expected.assignedFindingIds.some((id) => typeof id !== 'string' || !id)) fail('invalid_request', 'bad assignedFindingIds');
    if (new Set(expected.assignedFindingIds).size !== expected.assignedFindingIds.length) fail('invalid_request', 'duplicate assignedFindingIds');
    checkCorrelation(value.correlation, expected.correlation);
    const prefix = `${value.correlation.gate === 'sol' ? 'SOL' : 'TERRA'}-${value.correlation.number}-`;
    if (expected.freshFindingIdPrefix !== prefix) fail('invalid_request', 'freshFindingIdPrefix mismatch');
    checkEvidence(value, expected.requiredEvidence);
    checkFindings(value.findings, value.correlation, expected.assignedFindingIds, expected.freshFindingIdPrefix);
    const confirmed = checkConfirmations(value.findings, value.confirmations, expected.assignedFindingIds, value.correlation);
    checkVerdict(value, confirmed);
    return createResult('gate_result_validate', { verdict: value.verdict, correlation: value.correlation, evidenceRead: value.evidenceRead, findings: value.findings, confirmations: value.confirmations, decisions: value.decisions, adversarialResults: value.adversarialResults });
  } catch (error) {
    return createError('gate_result_validate', error.code || 'gate_result_invalid', error.message, 'gate_result_validate');
  }
}

module.exports = { SCHEMA, VERDICTS, GATES, SEVERITIES, ANCHORING, DISPOSITIONS, CONFIRMATIONS, EVIDENCE_KINDS, ADVERSARIAL_OUTCOMES, validateGateResult };

'use strict';

const { createResult, createError } = require('./protocol');

// Issue #36 (CL-D42). One versioned evidence envelope and a read-only preflight verifier.
// Every fingerprint travels as a labelled record so a record copied into the wrong field is
// detectable without a second source of truth, which the bare digests could not provide.
const VERSION = 1;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[^\s/]+\/[^\s/]+$/;
const DOMAINS = Object.freeze({
  issue_spec: 'normalized_text',
  pr_base: 'git_oid',
  pr_tree: 'git_oid',
  pr_head: 'git_oid',
  pr_diff: 'raw_bytes',
  pr_commits: 'normalized_text',
  snapshot: 'canonical_json',
});
const SHAPES = Object.freeze({ git_oid: OID, raw_bytes: DIGEST, normalized_text: DIGEST, canonical_json: DIGEST });
const ENVELOPE_KEYS = ['brackets', 'captureIdentity', 'completeness', 'fingerprints', 'schemaVersion'];
const CAPTURE_KEYS = ['baseBranch', 'baseOid', 'draft', 'headBranch', 'headOid', 'headRepository', 'number', 'repository', 'state'];
const EXPECTED_KEYS = CAPTURE_KEYS.concat(['fingerprints']).sort();
const STATES = ['closed', 'open'];
// bracket field -> the capture field it must witness
const WITNESS = Object.freeze({ repository: 'repository', number: 'number', base: 'baseOid', head: 'headOid', baseBranch: 'baseBranch', headRepository: 'headRepository', headBranch: 'headBranch', state: 'state', draft: 'draft' });
const RECORD_KEYS = ['domain', 'encoding', 'value'];
const IDENTITY_KEYS = ['base', 'baseBranch', 'draft', 'head', 'headBranch', 'headRepository', 'number', 'repository', 'state'];
const COMPLETENESS_KEYS = ['brackets', 'checks', 'nestedThreadComments', 'organizationRulesets', 'rest', 'reviewThreads', 'rulesetDetails'];

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysAre(value, expected) { return plain(value) && Object.keys(value).sort().join() === expected.join(); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function text(value) { return typeof value === 'string' && value.length > 0; }

function checkIdentityFields(value, label) {
  if (!text(value.repository) || !REPOSITORY.test(value.repository)) fail('envelope_invalid', `${label} repository must be owner/name`);
  if (!Number.isInteger(value.number) || value.number <= 0) fail('envelope_invalid', `${label} number must be a positive integer`);
  for (const field of ['baseOid', 'headOid']) if (!text(value[field]) || !OID.test(value[field])) fail('envelope_invalid', `${label} ${field} must be an object ID`);
  // Lifecycle and branch identity are required, not nullable: exact autofix cannot act on a
  // target whose state, draft flag, or head branch it could not observe.
  if (!text(value.headRepository) || !REPOSITORY.test(value.headRepository)) fail('envelope_invalid', `${label} headRepository must be owner/name`);
  for (const field of ['baseBranch', 'headBranch']) if (!text(value[field])) fail('envelope_invalid', `${label} ${field} is required`);
  if (!STATES.includes(value.state)) fail('envelope_invalid', `${label} state must be one of ${STATES.join(' or ')}`);
  if (typeof value.draft !== 'boolean') fail('envelope_invalid', `${label} draft must be a boolean`);
}
function checkCapture(capture) {
  if (!keysAre(capture, CAPTURE_KEYS)) fail('envelope_invalid', 'captureIdentity must carry exactly its identity fields');
  checkIdentityFields(capture, 'capture');
}

function createEvidenceFingerprintRecord(domain, value) {
  const encoding = DOMAINS[domain];
  if (!encoding) fail('envelope_invalid', `unknown fingerprint domain: ${String(domain)}`);
  if (!text(value) || !SHAPES[encoding].test(value)) fail('envelope_invalid', `${domain} value does not match its byte domain`);
  return { domain, encoding, value };
}

function checkFingerprints(fingerprints) {
  if (!keysAre(fingerprints, Object.keys(DOMAINS).sort())) fail('envelope_invalid', 'fingerprints must carry exactly the seven labelled domains');
  for (const [field, encoding] of Object.entries(DOMAINS)) {
    const record = fingerprints[field];
    if (!keysAre(record, RECORD_KEYS)) fail('envelope_invalid', `${field} must be a { domain, encoding, value } record`);
    if (record.domain !== field) fail('domain_mismatch', `${field} holds a record labelled ${String(record.domain)}`);
    if (record.encoding !== encoding) fail('encoding_mismatch', `${field} must declare the ${encoding} byte domain`);
    if (!text(record.value) || !SHAPES[encoding].test(record.value)) fail('envelope_invalid', `${field} value does not match its byte domain`);
  }
}

function checkIdentityShape(value, label) {
  if (!keysAre(value, IDENTITY_KEYS)) fail('envelope_invalid', `${label} bracket must carry exactly the captured identity fields`);
  if (!text(value.repository) || !REPOSITORY.test(value.repository)) fail('envelope_invalid', `${label} bracket repository must be owner/name`);
  if (!Number.isInteger(value.number) || value.number <= 0) fail('envelope_invalid', `${label} bracket number must be a positive integer`);
  for (const field of ['base', 'baseBranch', 'head', 'headRepository', 'headBranch']) if (!text(value[field])) fail('envelope_invalid', `${label} bracket ${field} is required`);
  if (!STATES.includes(value.state)) fail('envelope_invalid', `${label} bracket state must be one of ${STATES.join(' or ')}`);
  if (typeof value.draft !== 'boolean') fail('envelope_invalid', `${label} bracket draft must be a boolean`);
}

function checkBrackets(brackets) {
  if (!keysAre(brackets, ['after', 'before'])) fail('envelope_invalid', 'brackets must carry exactly before and after');
  checkIdentityShape(brackets.before, 'before');
  checkIdentityShape(brackets.after, 'after');
  for (const field of IDENTITY_KEYS) {
    if (brackets.before[field] !== brackets.after[field]) fail('bracket_identity_moved', `the target moved during capture: ${field}`);
  }
}

function checkCompleteness(completeness) {
  if (!plain(completeness)) fail('envelope_invalid', 'completeness must be an object');
  for (const key of Object.keys(completeness)) if (!COMPLETENESS_KEYS.includes(key)) fail('envelope_invalid', `unknown completeness field: ${key}`);
  for (const key of COMPLETENESS_KEYS) if (completeness[key] !== true) fail('evidence_incomplete', `completeness ${key} is missing or not proved`);
}

function checkExpected(envelope, expectation) {
  if (!keysAre(expectation, EXPECTED_KEYS)) fail('envelope_invalid', 'expected must carry exactly the identity fields and the seven fingerprints');
  if (!keysAre(expectation.fingerprints, Object.keys(DOMAINS).sort())) fail('envelope_invalid', 'expected fingerprints must name exactly the seven domains');
  checkIdentityFields(expectation, 'expected');
  const capture = envelope.captureIdentity;
  for (const field of CAPTURE_KEYS) {
    if (capture[field] !== expectation[field]) fail('identity_mismatch', `${field} does not match the expected target`);
  }
  // Shape checking is not comparison. Every domain is compared against the value the caller
  // expected, so a well-formed but stale or foreign digest cannot ride along under a correct
  // label.
  for (const field of Object.keys(DOMAINS)) {
    if (envelope.fingerprints[field].value !== expectation.fingerprints[field]) fail('fingerprint_mismatch', `the ${field} fingerprint does not match the expected value`);
  }
  // The envelope must also be internally consistent: the head and base it claims are the head
  // and base its own fingerprints carry, so a matching expectation cannot certify an envelope
  // that disagrees with itself.
  if (envelope.fingerprints.pr_head.value !== capture.headOid) fail('identity_mismatch', 'the head fingerprint does not match the captured head');
  if (envelope.fingerprints.pr_base.value !== capture.baseOid) fail('identity_mismatch', 'the base fingerprint does not match the captured base');
  // Both brackets must witness the identity the envelope claims, so a bracket cannot describe a
  // target the capture does not name.
  for (const bracket of ['before', 'after']) {
    for (const [field, claimed] of Object.entries(WITNESS)) {
      if (envelope.brackets[bracket][field] !== capture[claimed]) fail('identity_mismatch', `the ${bracket} bracket ${field} does not match the captured ${claimed}`);
    }
  }
}

function verifyEvidence(data) {
  try {
    if (!plain(data) || !plain(data.envelope) || !plain(data.expected)) fail('envelope_invalid', 'envelope and expected must be objects');
    const envelope = data.envelope;
    // The version is read before any other field, so an envelope from an unknown generation is
    // refused without interpreting a shape this verifier does not own.
    if (envelope.schemaVersion !== VERSION) fail('unsupported_schema_version', `unsupported evidence schema version: ${String(envelope.schemaVersion)}`);
    if (!keysAre(envelope, ENVELOPE_KEYS)) fail('envelope_invalid', 'the envelope must carry exactly its five sections');
    checkCapture(envelope.captureIdentity);
    checkFingerprints(envelope.fingerprints);
    checkBrackets(envelope.brackets);
    checkCompleteness(envelope.completeness);
    checkExpected(envelope, data.expected);
    return createResult('evidence_verify', { schemaVersion: VERSION, domains: Object.keys(DOMAINS), bracketStable: true });
  } catch (error) {
    return createError('evidence_verify', error.code || 'envelope_invalid', error.message, 'evidence_verify');
  }
}

module.exports = { verifyEvidence, createEvidenceFingerprintRecord, EVIDENCE_SCHEMA_VERSION: VERSION, EVIDENCE_DOMAINS: DOMAINS };

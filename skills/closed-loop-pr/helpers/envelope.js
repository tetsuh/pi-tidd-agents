'use strict';

// Issue #64 (CL-D72), split from launch.js without change: the volatile envelope a gate launch carries
// (CL-D2), closed and typed at every declared object and list, so that no caller-controlled key or
// structure reaches a reviewer task and every identity the envelope repeats agrees with the expectation.
// `build_gate_launch` in launch.js is its only consumer.

const { SCHEMA } = require('./gate-result');
const { FINGERPRINT_DOMAINS, FINGERPRINT_ENCODINGS, OID_PATTERN } = require('./evidence');

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'; }

// The volatile envelope is a closed, package-owned shape (the shared contract's volatile envelope and compact
// history projection): target, evidence fingerprints, the exact body or diff, Language Profile, acceptance
// criteria, and the compact gate history. No field carries an instruction; an unknown key never reaches the task.
const VOLATILE_FIELDS = Object.freeze({ target: 'object', fingerprints: 'object', body: 'string', diff: 'string', languageProfile: 'string', acceptanceCriteria: 'array', history: 'object', decisions: 'array', comments: 'array' });
// The complete CL-D2 envelope for the gate being composed: the diff is the PR root's exact change, and
// Sol's authoritative decisions and comments are its own duty (CL-D29). The gate correlation is derived
// from the expectation below, never supplied (ADV-123-VOLATILE-REQUIRED-FIELDS).
const VOLATILE_EVERY_GATE = Object.freeze(['target', 'fingerprints', 'body', 'languageProfile', 'acceptanceCriteria', 'history']);
function volatileRequired(workflow, gate) {
  return [...VOLATILE_EVERY_GATE, ...(workflow === 'pr' ? ['diff'] : []), ...(gate === 'adversarial' ? ['decisions', 'comments'] : [])];
}
// Each declared object of the envelope is closed too: an unknown key anywhere in it is caller prose that
// would ride into the task (ADV-123-NESTED-VOLATILE-ENVELOPE-PROSE). A record inside the history arrays is
// the parent ledger's projection, whose fields CL-D2 owns; the composer owns the envelope around it.
// An OID is 40 or 64 hex wherever the package reads one; each evidence identity has its domain's encoding
// (CONV-123-FINGERPRINT-DOMAIN-SHAPE).
const OID_TEXT = OID_PATTERN;
const TARGET_FIELDS = Object.freeze({
  repository: (v) => typeof v === 'string' && v.length > 0, headRepository: (v) => typeof v === 'string' && v.length > 0,
  number: (v) => Number.isInteger(v) && v > 0,
  mode: (v) => typeof v === 'string', gate: (v) => typeof v === 'string',
  headBranch: (v) => typeof v === 'string' && v.length > 0,
  baseOid: (v) => typeof v === 'string' && OID_TEXT.test(v), headOid: (v) => typeof v === 'string' && OID_TEXT.test(v),
});
const HISTORY_FIELDS = Object.freeze(['unresolved', 'reopened', 'settled']);
// A history record is a finding record or a settled summary: the finding fields the packaged schema declares,
// plus the projection fields CL-D2 names for a settled or reopened entry. Every record names its finding.
const HISTORY_RECORD_FIELDS = Object.freeze([...Object.keys(SCHEMA.properties.findings.items.properties),
  'sourceGate', 'raisedAgainst', 'disposition', 'dispositionRationale', 'confirmation', 'status', 'reviewedHead', 'summary']);
// The one declared object inside a record is closed by the same schema (CONV-123-HISTORY-RECORD-CLOSURE).
const WORKFLOW_RECORD_FIELDS = Object.freeze(Object.keys(SCHEMA.properties.findings.items.properties.workflowRecord.properties));
// The evidence identities the correlation already fixes; a repeated one must agree with it.
const FINGERPRINT_CORRELATED = Object.freeze({ pr_head: 'headOid', pr_base: 'baseOid', snapshot: 'snapshotFingerprint' });
const RECORD_LISTS = Object.freeze(['decisions', 'comments']);
// A decision or comment is a record the gate cites: its identity, its author, when it was written, and its
// body, which is the target's own text. The package owns this shape. GitHub's own issue-comment record is
// read by the fields it declares and reduced to it, so nothing GitHub adds, and nothing a caller adds to it,
// is serialized; rejecting GitHub's undeclared fields would make the composer the owner of GitHub's schema,
// which has changed twice in the observed records (CONV-123-NESTED-RECORD-PROSE).
const CITED_RECORD_FIELDS = Object.freeze({
  // GitHub's identity is an integer; a parent that has already projected it carries it as digits.
  id: (v) => (Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9][0-9]*$/.test(v)), url: (v) => typeof v === 'string' && v.length > 0,
  author: (v) => typeof v === 'string' && v.length > 0, authorType: (v) => typeof v === 'string' && v.length > 0,
  authorAssociation: (v) => typeof v === 'string' && v.length > 0, createdAt: (v) => typeof v === 'string' && v.length > 0,
  updatedAt: (v) => typeof v === 'string' && v.length > 0, body: (v) => typeof v === 'string',
});
const CITED_RECORD_REQUIRED = Object.freeze(['id', 'url', 'author', 'updatedAt', 'body']);
function citedRecord(field, record) {
  if (!plain(record) || Object.keys(record).length === 0) return { problem: { code: 'invalid_request', message: `volatile field ${field} must be a list of records` } };
  let projected = record;
  if (plain(record.user)) {
    const github = { id: record.id, url: record.html_url, author: record.user.login, authorType: record.user.type, authorAssociation: record.author_association, createdAt: record.created_at, updatedAt: record.updated_at, body: record.body };
    projected = Object.fromEntries(Object.entries(github).filter(([, value]) => value !== undefined && value !== null));
  }
  for (const [key, value] of Object.entries(projected)) {
    if (!Object.hasOwn(CITED_RECORD_FIELDS, key)) return { problem: { code: 'volatile_unknown_field', message: `volatile carries an unknown field: ${field}[].${key}` } };
    if (!CITED_RECORD_FIELDS[key](value)) return { problem: { code: 'invalid_request', message: `volatile field ${field}[].${key} is not the declared shape` } };
  }
  for (const key of CITED_RECORD_REQUIRED) if (!Object.hasOwn(projected, key)) return { problem: { code: 'invalid_request', message: `volatile field ${field}[] must carry ${key}` } };
  return { record: projected };
}
// The cited lists, reduced; or the first problem among them.
function citedRecords(v) {
  const lists = {};
  for (const field of RECORD_LISTS) {
    if (!Object.hasOwn(v, field)) continue;
    lists[field] = [];
    for (const record of v[field]) {
      const cited = citedRecord(field, record);
      if (cited.problem) return { problem: cited.problem };
      lists[field].push(cited.record);
    }
  }
  return { lists };
}
// The evidence identities each root's gates review (CL-D9), and the two modes CL-D6 parses.
// A root's gates review exactly these domains: each is required, and no other is accepted.
const FINGERPRINT_SET = Object.freeze({ pr: FINGERPRINT_DOMAINS, issue: Object.freeze(['issue_spec', 'snapshot']) });
const MODES = Object.freeze(['autofix', 'review-only']);
// The identities a target may repeat. The expectation is the authority for each; the target's copy is
// checked against it rather than trusted, and a copy it does not carry is not required (CL-D47's rule).
const TARGET_CORRELATED = Object.freeze(['repository', 'number', 'baseOid', 'headOid', 'headBranch', 'headRepository']);
// A required field that carries nothing is not the envelope: an empty target names no target, an empty body
// no content, no criteria no scope (ADV-123-VOLATILE-REQUIRED-FIELDS). `decisions` and `comments` may be
// empty, because a target can legitimately carry neither.
// Every declared object, key by key, before any of it is serialized.
function nestedProblem(v, correlation, workflow) {
  for (const [key, value] of Object.entries(v.target)) {
    if (!Object.hasOwn(TARGET_FIELDS, key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: target.${key}` };
    if (!TARGET_FIELDS[key](value)) return { code: 'invalid_request', message: `volatile field target.${key} is not the declared shape` };
  }
  for (const [key, value] of Object.entries(v.fingerprints)) {
    if (!FINGERPRINT_SET[workflow].includes(key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: fingerprints.${key}` };
    if (typeof value !== 'string' || !FINGERPRINT_ENCODINGS[key].test(value)) return { code: 'invalid_request', message: `volatile field fingerprints.${key} is not a ${key} identity` };
    const correlated = FINGERPRINT_CORRELATED[key];
    if (correlated && value !== correlation[correlated]) return { code: 'invalid_request', message: `volatile field fingerprints.${key} disagrees with the expectation on ${correlated}` };
  }
  for (const [key, value] of Object.entries(v.history)) {
    if (!HISTORY_FIELDS.includes(key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}` };
    if (!Array.isArray(value) || value.some((record) => !plain(record))) return { code: 'invalid_request', message: `volatile field history.${key} must be a list of records` };
    for (const record of value) {
      for (const field of Object.keys(record)) {
        if (!HISTORY_RECORD_FIELDS.includes(field)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}[].${field}` };
      }
      if (typeof record.findingId !== 'string' || record.findingId.length === 0) return { code: 'invalid_request', message: `volatile field history.${key} carries a record naming no finding` };
      // Every value in a record is a scalar, and the one declared object holds scalars: nothing deeper can
      // be composed, so no structure carries prose past the declared names.
      for (const [field, value] of Object.entries(record)) {
        if (field === 'workflowRecord') {
          if (!plain(value)) return { code: 'invalid_request', message: `volatile field history.${key}[].workflowRecord must be a record` };
          for (const [inner, held] of Object.entries(value)) {
            if (!WORKFLOW_RECORD_FIELDS.includes(inner)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}[].workflowRecord.${inner}` };
            if (!scalar(held)) return { code: 'invalid_request', message: `volatile field history.${key}[].workflowRecord.${inner} is not a value` };
          }
          continue;
        }
        if (!scalar(value)) return { code: 'invalid_request', message: `volatile field history.${key}[].${field} is not a value` };
      }
    }
  }
  return null;
}
function volatileEmptiness(expected, v) {
  const workflow = expected.workflow, correlation = expected.correlation;
  const filled = (value) => typeof value === 'string' && value.trim().length > 0;
  const bad = (field, why) => `volatile field ${field} ${why}`;
  if (!filled(v.body)) return bad('body', 'must carry the exact body under review');
  if (workflow === 'pr' && !filled(v.diff)) return bad('diff', 'must carry the exact diff under review');
  if (!filled(v.languageProfile)) return bad('languageProfile', 'must name the Language Profile');
  if (!v.acceptanceCriteria.length || !v.acceptanceCriteria.every(filled)) return bad('acceptanceCriteria', 'must carry at least one criterion');
  if (!filled(v.target.repository) || !Number.isInteger(v.target.number) || v.target.number < 1) return bad('target', 'must name the repository and the target number');
  // The target is complete or it is not the target: the head it reviews, the base it is measured against,
  // and the branch it sits on, each checked against the expectation below.
  for (const key of ['baseOid', 'headOid', 'headBranch']) if (!filled(v.target[key])) return bad('target', `must name ${key}`);
  // CL-D2's mode or gate correlation: the gate is the expectation's, and the mode is one CL-D6 parses.
  if (!MODES.includes(v.target.mode)) return bad('target', `must name the mode, one of ${MODES.join(', ')}`);
  if (v.target.gate !== correlation.gate) return bad('target', `must name the gate the expectation names: ${correlation.gate}`);
  for (const key of TARGET_CORRELATED) {
    if (Object.hasOwn(v.target, key) && v.target[key] !== correlation[key]) return bad('target', `disagrees with the expectation on ${key}`);
  }
  for (const key of FINGERPRINT_SET[workflow]) if (!filled(v.fingerprints[key])) return bad('fingerprints', `must carry ${key}`);
  for (const [key, value] of Object.entries(v.fingerprints)) if (!filled(value)) return bad('fingerprints', `carries an empty ${key}`);
  // The compact projection is complete or it is not the projection: a child without the reopened list cannot
  // see which settled findings came back (CL-D2, CONV-123-HISTORY-REOPENED-OMISSION).
  for (const key of HISTORY_FIELDS) if (!Array.isArray(v.history[key])) return bad('history', `must carry the ${key} projection`);
  return null;
}

module.exports = { VOLATILE_FIELDS, volatileRequired, volatileEmptiness, nestedProblem, citedRecords };

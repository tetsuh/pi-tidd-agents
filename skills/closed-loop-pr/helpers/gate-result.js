'use strict';

const { createResult, createError } = require('./protocol');
const words = (s) => s.split(' ');
const VERDICTS = ['MERGE', 'FIX BEFORE MERGE', 'NEEDS DECISION'], ROOTS = ['issue', 'pr'];
// Gate identities per envelope version (CL-D60): version 2 names workflow functions, each valid
// only on the root that runs it; version 1 stays accepted verbatim for one release, unmapped.
// `convergence` (CL-D62) is the non-authoritative preliminary stage, valid on both roots.
const GATES = { 1: ['sol', 'terra'], 2: ['adversarial', 'decision-drift', 'safety', 'convergence'] };
const ROOT_GATES = { issue: ['adversarial', 'decision-drift', 'convergence'], pr: ['adversarial', 'safety', 'convergence'] };
const PREFIX = { sol: 'SOL', terra: 'TERRA', adversarial: 'ADV', 'decision-drift': 'DRIFT', safety: 'SAFETY', convergence: 'CONV' };
// Version 1 keeps its exact legacy diagnostic (ADV-106-V1-VERBATIM); version 2 has its own.
const ADVERSARIAL = { 1: 'sol', 2: 'adversarial' }, ADVERSARIAL_MISSING = { sol: 'Sol adversarial missing', adversarial: 'adversarial results missing' };
const SEVERITIES = ['Blocker', 'Major', 'Minor'], ANCHORING = ['criterion-anchored', 'reword', 'follow-up'];
const DISPOSITIONS = words('fixed accepted-as-designed deferred duplicate not-applicable needs-owner-decision');
const CONFIRMS = words('confirmed rejected unverifiable'), KINDS = words('file git github snapshot');
const OUTCOMES = words('counterexample unavailable-evidence no-counterexample');
const EXTERNAL = words('sourceUrl bodyDigest createdAt updatedAt');
const SRC_X = { gate: [], body: EXTERNAL, 'issue-comment': EXTERNAL, review: [...EXTERNAL, 'reviewCommitOid'],
  'inline-comment': [...EXTERNAL, 'reviewCommitOid', 'path', 'line'], check: EXTERNAL, status: EXTERNAL };
const SOURCES = Object.keys(SRC_X);
const OID = { type: 'string', pattern: '^[0-9a-f]{40}(?:[0-9a-f]{24})?$' }, SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const TEXT = { type: 'string', minLength: 1 }, NWO = { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' };
const closed = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const list = (items) => ({ type: 'array', items }), choice = (enumValues) => ({ type: 'string', enum: enumValues });
const fields = (s) => Object.fromEntries(words(s).map((key) => [key, TEXT]));

const CORR_REQ = words('repository number baseOid headRepository headBranch headOid lifecycle draft gate invocation contractInput snapshotFingerprint');
const corr = (gate) => closed({ ...fields('headBranch'), repository: NWO, number: { type: 'integer', minimum: 1 }, baseOid: OID,
  headRepository: NWO, headOid: OID, lifecycle: choice(words('open closed merged')), draft: { type: 'boolean' },
  gate, invocation: { type: 'integer', minimum: 1 }, contractInput: SHA256, snapshotFingerprint: SHA256 }, CORR_REQ);
const RECORD = closed({ ...fields('candidateIdentity revisedPassage snapshotAssignment sourceId sourceUrl authorIdentity authorType createdAt updatedAt path correctiveChange replyUrl'),
  sourceKind: choice(SOURCES), bodyDigest: SHA256, reviewCommitOid: OID, line: { type: 'integer', minimum: 1 },
  observedHeadOid: OID, fingerprint: SHA256, semanticFingerprint: SHA256 });
const finding = (gate) => closed({ ...fields('findingId blockerKey anchor proposedIssueTitle evidence impact rationale correction validationEvidence transport'),
  origin: choice(words('assigned fresh')), gate, headOid: OID, raisedAgainstFingerprint: SHA256,
  severity: choice(SEVERITIES), anchoring: choice(ANCHORING), outOfScope: { type: 'boolean' },
  proposedDisposition: choice(DISPOSITIONS), workflowRecord: RECORD },
  words('findingId origin gate headOid raisedAgainstFingerprint severity proposedDisposition evidence impact rationale correction transport workflowRecord'));
const confirm = (gate) => closed({ ...fields('findingId evidence'), gate, headOid: OID,
  confirmation: choice(CONFIRMS) }, words('findingId gate headOid confirmation evidence'));
const DEC = closed({ ...fields('decisionId kind targetAndRevision question options recommendation ownerChoice rationale validity'),
  status: choice(words('pending recorded')) }, words('decisionId kind targetAndRevision question options recommendation rationale validity status'));
const EVID = closed({ ...fields('source identity'), kind: choice(KINDS), readCompletely: { type: 'boolean' } }, words('source kind identity readCompletely'));
const ADV = closed({ ...fields('claim searched evidence findingId'), outcome: choice(OUTCOMES) }, words('claim searched outcome evidence'));
const schemaFor = (version) => {
  const gate = choice(GATES[version]);
  return closed({ schemaVersion: { type: 'integer', const: version }, correlation: corr(gate), verdict: choice(VERDICTS),
    evidenceRead: list(EVID), findings: list(finding(gate)), confirmations: list(confirm(gate)), decisions: list(DEC),
    adversarialResults: list(ADV) }, words('schemaVersion correlation verdict evidenceRead findings confirmations decisions adversarialResults'));
};
const SCHEMAS = { 1: schemaFor(1), 2: schemaFor(2) }, SCHEMA = SCHEMAS[2];

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(s, v, p = 'envelope') {
  if (s.type === 'array') {
    if (!Array.isArray(v)) fail('schema_invalid', `${p}: array`);
    v.forEach((x, i) => check(s.items, x, `${p}[${i}]`)); return;
  }
  if (s.type === 'object') {
    if (!plain(v)) fail('schema_invalid', `${p}: object`);
    for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties, k)) fail('unknown_field', `${p}: unknown ${k}`);
    for (const k of s.required) if (!Object.hasOwn(v, k)) fail('schema_invalid', `${p}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) check(s.properties[k], x, `${p}.${k}`); return;
  }
  if (s.type === 'integer') {
    if (!Number.isSafeInteger(v)) fail('schema_invalid', `${p}: integer`);
    if (Object.hasOwn(s, 'const') && v !== s.const) fail('unknown_version', `${p}: version`);
    if (s.minimum && v < s.minimum) fail('schema_invalid', `${p}: minimum`); return;
  }
  if (s.type === 'boolean') { if (typeof v !== 'boolean') fail('schema_invalid', `${p}: boolean`); return; }
  if (typeof v !== 'string') fail('schema_invalid', `${p}: string`);
  if (s.enum && !s.enum.includes(v)) fail('unknown_enum', `${p}: enum`);
  if (s.pattern && !new RegExp(s.pattern).test(v)) fail('schema_invalid', `${p}: pattern`);
  if (s.minLength && !v.length) fail('schema_invalid', `${p}: empty`);
}
function expectedState(e) {
  if (!plain(e) || !plain(e.correlation) || !ROOTS.includes(e.workflow)) fail('invalid_request', 'bad expected root');
  const a = e.assignedFindings;
  if (!Array.isArray(a) || a.some((x) => !plain(x) || Object.keys(x).sort().join() !== 'blockerKey,findingId'
    || !words('findingId blockerKey').every((k) => typeof x[k] === 'string' && x[k]))) fail('invalid_request', 'bad assignments');
  const ids = a.map((x) => x.findingId);
  if (new Set(ids).size !== ids.length) fail('invalid_request', 'duplicate assignment');
  return new Map(a.map((x) => [x.findingId, x.blockerKey]));
}
function checkCorrelation(a, e) {
  for (const k of CORR_REQ) if (a[k] !== e[k]) fail('correlation_mismatch', `${k} mismatch`);
}
function checkRequiredEvidence(req) {
  const key = (x) => JSON.stringify([x.source, x.kind, x.identity]);
  if (!Array.isArray(req) || !req.length) fail('invalid_request', 'evidence missing');
  for (const x of req) if (!plain(x) || Object.keys(x).sort().join() !== 'identity,kind,source'
    || !words('source identity').every((k) => typeof x[k] === 'string' && x[k]) || !KINDS.includes(x.kind)) fail('invalid_request', 'bad requiredEvidence');
  const e = req.map(key);
  if (new Set(e).size !== e.length) fail('invalid_request', 'duplicate expected evidence');
  return e;
}
function checkEvidence(v, req, adversarialGate) {
  const bad = (m) => fail('evidence_records_invalid', m), key = (x) => JSON.stringify([x.source, x.kind, x.identity]);
  const e = checkRequiredEvidence(req), a = v.evidenceRead.map(key);
  if (new Set(a).size !== a.length) bad('duplicate evidence');
  if (v.evidenceRead.some((x) => !x.readCompletely)) bad('incomplete evidence');
  if (e.some((x) => !a.includes(x))) bad('required evidence omitted');
  if (a.some((x) => !e.includes(x))) bad('unexpected evidence');
  if (v.correlation.gate === adversarialGate && !v.adversarialResults.length) bad(ADVERSARIAL_MISSING[adversarialGate]);
  const ids = new Set(v.findings.map((x) => x.findingId)), material = new Set();
  for (const x of v.adversarialResults) {
    if ((x.outcome !== 'no-counterexample') !== Boolean(x.findingId) || (x.findingId && !ids.has(x.findingId))) bad('adversarial linkage');
    if (x.findingId) material.add(x.findingId);
  }
  return material;
}
const ISSUE = words('candidateIdentity revisedPassage snapshotAssignment');
const PR_REQ = words('sourceKind sourceId observedHeadOid fingerprint semanticFingerprint authorIdentity authorType');
function checkWorkflowRecord(x, root) {
  const bad = (m) => fail('finding_records_invalid', `${x.findingId}: ${m}`), r = x.workflowRecord;
  if (root === 'issue') {
    if (Object.keys(r).some((k) => !ISSUE.includes(k)) || !r.candidateIdentity || !r.snapshotAssignment) bad('Issue record');
    if (x.proposedDisposition === 'fixed' && !r.revisedPassage) bad('revised passage');
    return;
  }
  const extra = SRC_X[r.sourceKind] || [], allowed = new Set([...PR_REQ, ...extra, 'correctiveChange', 'replyUrl']);
  if (Object.keys(r).some((k) => !allowed.has(k)) || PR_REQ.some((k) => !r[k]) || extra.some((k) => !r[k])) bad('PR record');
  if (r.observedHeadOid !== x.headOid) bad('PR head mismatch');
  if (x.proposedDisposition === 'fixed' && !r.correctiveChange) bad('corrective change');
}
function checkFindings(findings, corr, assigned, prefix, root) {
  const bad = (m) => fail('finding_records_invalid', m), ids = findings.map((x) => x.findingId);
  if (new Set(ids).size !== ids.length) bad('duplicate findingId');
  for (const x of findings) {
    if (x.gate !== corr.gate || x.headOid !== corr.headOid) bad(`${x.findingId}: gate/head mismatch`);
    if (Object.hasOwn(x, 'outOfScope') && x.outOfScope !== true) bad(`${x.findingId}: false outOfScope`);
    const residual = x.outOfScope === true;
    if (residual === Boolean(x.anchoring)) bad(`${x.findingId}: classification`);
    if (x.anchoring === 'criterion-anchored' && !x.anchor) bad(`${x.findingId}: anchor`);
    if (x.anchoring === 'reword' && (x.severity === 'Blocker' || !['fixed', 'accepted-as-designed'].includes(x.proposedDisposition))) bad(`${x.findingId}: reword`);
    if (x.anchoring === 'follow-up' && (!x.proposedIssueTitle || x.proposedDisposition !== 'deferred' || x.severity === 'Blocker')) bad(`${x.findingId}: follow-up`);
    if (residual && (x.severity !== 'Minor' || !['accepted-as-designed', 'deferred', 'not-applicable'].includes(x.proposedDisposition))) bad(`${x.findingId}: out-of-scope`);
    if (x.origin === 'assigned') {
      if (assigned.get(x.findingId) !== x.blockerKey) bad(`assigned tuple mismatch for ${x.findingId}`);
      if (x.proposedDisposition === 'fixed' && !x.validationEvidence) bad(`${x.findingId}: validation`);
    } else {
      if (assigned.has(x.findingId)) bad(`${x.findingId}: assigned ID is fresh`);
      if (!x.findingId.startsWith(prefix) || !/^[A-Z0-9._-]+$/.test(x.findingId.slice(prefix.length))) bad(`${x.findingId}: namespace`);
      if (x.blockerKey) bad(`${x.findingId}: fresh blockerKey`);
    }
    checkWorkflowRecord(x, root);
  }
  for (const id of assigned.keys()) if (!findings.some((x) => x.findingId === id && x.origin === 'assigned')) fail('confirmation_records_invalid', `result omits assigned finding ${id}`);
}
function checkConfirmations(findings, confirmations, assigned, corr) {
  const bad = (m) => fail('confirmation_records_invalid', m), reported = findings.filter((x) => x.origin === 'assigned').map((x) => x.findingId), seen = new Map();
  for (const x of confirmations) {
    if (seen.has(x.findingId) || !assigned.has(x.findingId)) bad(`unexpected/duplicate ${x.findingId}`);
    if (x.gate !== corr.gate || x.headOid !== corr.headOid) bad(`${x.findingId}: gate/head`);
    seen.set(x.findingId, x);
  }
  for (const id of reported) if (!seen.has(id)) bad(`missing ${id}`);
  return seen;
}
function checkVerdict(v, confirmed, material) {
  const bad = (m) => fail('verdict_inconsistent', m), pending = v.decisions.filter((x) => x.status === 'pending');
  if (new Set(v.decisions.map((x) => x.decisionId)).size !== v.decisions.length) bad('duplicate decisionId');
  for (const x of v.decisions) {
    if (x.status === 'recorded' && !x.ownerChoice) bad(`${x.decisionId}: owner choice`);
    if (x.status === 'pending' && x.ownerChoice) bad(`${x.decisionId}: pending choice`);
  }
  const owner = v.findings.some((x) => x.proposedDisposition === 'needs-owner-decision');
  const unresolved = v.findings.filter((x) => x.origin === 'assigned'
    ? confirmed.get(x.findingId).confirmation !== 'confirmed' || x.proposedDisposition === 'needs-owner-decision'
      || (x.proposedDisposition === 'fixed' && material.has(x.findingId))
    : x.outOfScope !== true && !(x.anchoring === 'follow-up' && x.proposedDisposition === 'deferred'));
  if (owner && (v.verdict !== 'NEEDS DECISION' || pending.length !== 1)) bad('owner state');
  if (v.verdict === 'MERGE' && (unresolved.length || pending.length)) bad('MERGE state');
  if (v.verdict === 'FIX BEFORE MERGE' && (!unresolved.length || pending.length)) bad('FIX state');
  if (v.verdict === 'NEEDS DECISION' && pending.length !== 1) bad('decision count');
}
function validateGateResult(v, e) {
  try {
    // The version branch is explicit: an envelope is checked against its own version's schema,
    // so a version 1 gate inside a version 2 envelope (or the reverse) is an unknown enum, never
    // a mapped value; an unlisted version falls to the shipping schema's const and fails there.
    const version = plain(v) && Object.hasOwn(SCHEMAS, v.schemaVersion) ? v.schemaVersion : 2;
    check(SCHEMAS[version], v); const assigned = expectedState(e);
    checkCorrelation(v.correlation, e.correlation);
    if (version === 2 && !ROOT_GATES[e.workflow].includes(v.correlation.gate)) fail('correlation_mismatch', `gate ${v.correlation.gate} is not a ${e.workflow} gate`);
    // The namespace is derived, never supplied: a hand-copied duplicate of a derivable value
    // can only ever be wrong, and in the field a copy mismatch destroyed completed verdicts.
    if ('freshFindingIdPrefix' in e) fail('invalid_request', 'freshFindingIdPrefix is derived from the correlation; do not supply it');
    const prefix = `${PREFIX[v.correlation.gate]}-${v.correlation.number}-`;
    const material = checkEvidence(v, e.requiredEvidence, ADVERSARIAL[version]);
    checkFindings(v.findings, v.correlation, assigned, prefix, e.workflow);
    const confirmed = checkConfirmations(v.findings, v.confirmations, assigned, v.correlation);
    checkVerdict(v, confirmed, material);
    return createResult('gate_result_validate', { verdict: v.verdict, correlation: v.correlation, evidenceRead: v.evidenceRead,
      findings: v.findings, confirmations: v.confirmations, decisions: v.decisions, adversarialResults: v.adversarialResults });
  } catch (error) { return createError('gate_result_validate', error.code || 'gate_result_invalid', error.message, 'gate_result_validate'); }
}
// checkSchema exposes the same structural walk validateGateResult applies, so builders can
// validate a correlation with the boundary's own checker instead of a re-derivation.
function checkSchema(schema, value, pathName = 'value') { check(schema, value, pathName); }
module.exports = { SCHEMA, SCHEMAS, validateGateResult, expectedState, checkRequiredEvidence, checkSchema };

'use strict';

// Issue #190 (CL-D120), step 1. Version 2's gate result correlation named a pull request's base, head repository, head
// branch, head and draft on both roots, so an Issue gate result validated only with invented values. Version 2 now has
// an Issue correlation beside the pull-request one: the pull-request shapes keep their bytes, the validator checks each
// envelope against its root's own closed schema, and each gate role declares the schema of the roots its gate reviews
// (owner choice, issues/190#issuecomment-6233941786).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, readContract, sectionOf, readManifest, issueCorrelationOf, ISSUE_SPEC } = require('./helpers');

const OID = 'a'.repeat(40), SHA = '1'.repeat(64), CANDIDATE = 'f'.repeat(64);
const RUN = '19019019-0190-4190-8190-190190190190';
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const EVIDENCE = [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }];
const ROLES = ['tidd-adversarial-reviewer', 'tidd-convergence-reviewer', 'tidd-drift-reviewer', 'tidd-safety-reviewer'];

const prCorrelation = (gate) => ({ repository: 'o/r', number: 190, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) });
const issueCorrelation = (gate, over = {}) => issueCorrelationOf(prCorrelation(gate), over);
const expectation = (workflow, correlation, assignedFindings = []) => ({ workflow, correlation, assignedFindings, requiredEvidence: EVIDENCE });
function envelope(correlation, over = {}) {
  return {
    schemaVersion: 2, correlation, verdict: 'MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', readCompletely: true }],
    findings: [], confirmations: [], decisions: [],
    adversarialResults: ['adversarial', 'sol'].includes(correlation.gate) ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [],
    ...over,
  };
}
function issueFinding(correlation, over = {}) {
  return {
    findingId: 'ADV-190-SHAPE', origin: 'fresh', gate: correlation.gate, issueSpec: correlation.issueSpec, raisedAgainstFingerprint: SHA,
    severity: 'Major', anchoring: 'criterion-anchored', anchor: 'AC1', proposedDisposition: 'fixed',
    evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending',
    workflowRecord: { revisedPassage: 'revised', snapshotAssignment: 'snapshot A', ...(correlation.candidateIdentity ? { candidateIdentity: correlation.candidateIdentity } : {}) },
    ...over,
  };
}
const withFinding = (correlation, finding) => envelope(correlation, { verdict: 'FIX BEFORE MERGE', findings: [finding] });
function refused(result, code, message) {
  assert.equal(result.ok, false, `must be refused: ${message}`);
  assert.equal(result.error.code, code, JSON.stringify(result.error));
  if (message) assert.match(result.error.message, message);
}

test('Issue #190 the pull-request schema keeps its bytes, and version 1 is unchanged', () => {
  // The digests of the schemas as they were before CL-D120, measured on c6a659c.
  assert.equal(digest(gateResult.SCHEMA), '755afc25cc0d295a489efc53b2294c7290518aaf45f43a1d17e2caa6de257703');
  assert.equal(digest(gateResult.SCHEMAS[1]), 'b1604ec180923d8e5ac2fa12bd605bd76f43acd7f6721c7100b0bd89dc76853b');
  assert.deepEqual(Object.keys(gateResult.SCHEMAS), ['1', '2']);
  assert.equal(gateResult.SCHEMAS[2], gateResult.SCHEMA);
  // The history projection still reads the pull-request finding shape by default.
  assert.ok(gateResult.findingShape().required.includes('headOid'));
  assert.ok(gateResult.findingShape('issue').required.includes('issueSpec'));
  assert.equal(Object.hasOwn(gateResult.findingShape('issue').properties, 'headOid'), false);
});

test('Issue #190 the Issue correlation is closed and names no pull-request field', () => {
  const corr = gateResult.correlationSchema('issue');
  assert.deepEqual(Object.keys(corr.properties).sort(), ['candidateIdentity', 'contractInput', 'gate', 'invocation', 'issueSpec', 'lifecycle', 'number', 'repository', 'snapshotFingerprint']);
  assert.deepEqual([...corr.required].sort(), ['contractInput', 'gate', 'invocation', 'issueSpec', 'lifecycle', 'number', 'repository', 'snapshotFingerprint']);
  assert.equal(corr.additionalProperties, false);
  assert.deepEqual(corr.properties.lifecycle.enum, ['open', 'closed']);
  assert.deepEqual(corr.properties.gate.enum, gateResult.SCHEMA.properties.correlation.properties.gate.enum, 'the gate stays the version 2 vocabulary, so another root\'s gate is a correlation mismatch');
  assert.equal(gateResult.correlationSchema('pr'), gateResult.SCHEMA.properties.correlation);
  const issue = gateResult.ISSUE_SCHEMA;
  assert.deepEqual(issue.properties.confirmations.items.required, ['findingId', 'gate', 'issueSpec', 'confirmation', 'evidence']);
  assert.deepEqual(Object.keys(issue.properties.findings.items.anyOf[0].properties.workflowRecord.properties).sort(), ['candidateIdentity', 'revisedPassage', 'snapshotAssignment']);
  assert.deepEqual(issue.properties.findings.items.anyOf[0].properties.workflowRecord.required, ['snapshotAssignment']);
});

test('Issue #190 each gate role declares the schema of the roots its gate reviews', () => {
  const { ROLE_SCHEMAS, SCHEMA, ISSUE_SCHEMA } = gateResult;
  assert.deepEqual(Object.keys(ROLE_SCHEMAS).sort(), ROLES);
  assert.equal(ROLE_SCHEMAS['tidd-safety-reviewer'], SCHEMA);
  assert.equal(ROLE_SCHEMAS['tidd-drift-reviewer'], ISSUE_SCHEMA);
  // CL-D121: convergence reviews the pull-request root only.
  assert.equal(ROLE_SCHEMAS['tidd-convergence-reviewer'], SCHEMA);
  for (const role of ['tidd-adversarial-reviewer']) {
    const union = ROLE_SCHEMAS[role];
    // The root stays an object; the branches sit inside it.
    assert.equal(union.type, 'object');
    assert.deepEqual(union.properties.correlation.anyOf, [SCHEMA.properties.correlation, ISSUE_SCHEMA.properties.correlation]);
    assert.deepEqual(union.properties.findings.items.anyOf, [...SCHEMA.properties.findings.items.anyOf, ...ISSUE_SCHEMA.properties.findings.items.anyOf]);
    assert.deepEqual(union.properties.confirmations.items.anyOf, [SCHEMA.properties.confirmations.items, ISSUE_SCHEMA.properties.confirmations.items]);
  }
  // Nothing outside the read sees a role schema, so no envelope is ever checked against a union.
  for (const file of fs.readdirSync('skills/closed-loop-pr/helpers').filter((f) => f.endsWith('.js'))) {
    const source = readText(`skills/closed-loop-pr/helpers/${file}`);
    if (!['gate-result.js', 'launch.js', 'index.js'].includes(file)) assert.equal(source.includes('ROLE_SCHEMAS'), false, `${file} names no role schema`);
  }
  // Every walk starts at a root schema: the envelope's, the expectation's correlation, or the builder's correlation.
  const source = readText('skills/closed-loop-pr/helpers/gate-result.js');
  assert.deepEqual([...source.matchAll(/(?<!function )\bcheck\(([^,]+),/g)].map((m) => m[1]), ['loose', 's.items', 's.properties[k]', 'ROOT_SCHEMAS[version][e.workflow].properties.correlation', 'ROOT_SCHEMAS[version][root]', 'schema']);
  assert.deepEqual([...readText('skills/closed-loop-pr/helpers/builders.js').matchAll(/\bcheckSchema\(([^,]+),/g)].map((m) => m[1]), ['correlationSchema(data.workflow)']);
});

test('Issue #190 an Issue result validates with the Issue\'s own correlation, before and during a candidate', () => {
  for (const gate of ['adversarial', 'decision-drift']) {
    for (const corr of [issueCorrelation(gate), issueCorrelation(gate, { candidateIdentity: CANDIDATE })]) {
      const clean = gateResult.validateGateResult(envelope(corr), expectation('issue', corr));
      assert.equal(clean.ok, true, `${gate}: ${JSON.stringify(clean.error)}`);
      const id = `${{ adversarial: 'ADV', 'decision-drift': 'DRIFT' }[gate]}-190-SHAPE`;
      const found = gateResult.validateGateResult(withFinding(corr, issueFinding(corr, { findingId: id })), expectation('issue', corr));
      assert.equal(found.ok, true, `${gate} finding: ${JSON.stringify(found.error)}`);
    }
  }
});

test('Issue #190 an Issue result naming a pull-request field, or another Issue identity, is refused', () => {
  const corr = issueCorrelation('adversarial', { candidateIdentity: CANDIDATE });
  const e = expectation('issue', corr);
  for (const field of ['baseOid', 'headOid', 'headBranch', 'headRepository', 'draft']) {
    refused(gateResult.validateGateResult(envelope({ ...corr, [field]: prCorrelation('adversarial')[field] }), e), 'unknown_field', new RegExp(`correlation: unknown ${field}`));
  }
  // The candidate is named exactly when the expectation names it, both ways.
  const { candidateIdentity: _omit, ...pre } = corr;
  refused(gateResult.validateGateResult(envelope(pre), e), 'correlation_mismatch', /candidateIdentity mismatch/);
  refused(gateResult.validateGateResult(envelope(corr), expectation('issue', pre)), 'correlation_mismatch', /candidateIdentity mismatch/);
  refused(gateResult.validateGateResult(envelope({ ...corr, issueSpec: '2'.repeat(64) }), e), 'correlation_mismatch', /issueSpec mismatch/);
  refused(gateResult.validateGateResult(envelope({ ...corr, lifecycle: 'merged' }), e), 'unknown_enum');
  // A finding binds by issueSpec, never headOid, and its record names this candidate.
  refused(gateResult.validateGateResult(withFinding(corr, { ...issueFinding(corr), headOid: OID }), e), 'unknown_field', /unknown headOid/);
  refused(gateResult.validateGateResult(withFinding(corr, issueFinding(corr, { issueSpec: '2'.repeat(64) })), e), 'finding_records_invalid', /gate\/head mismatch/);
  refused(gateResult.validateGateResult(withFinding(corr, issueFinding(corr, { workflowRecord: { revisedPassage: 'r', snapshotAssignment: 's', candidateIdentity: '3'.repeat(64) } })), e), 'finding_records_invalid', /Issue record/);
  refused(gateResult.validateGateResult(withFinding(corr, issueFinding(corr, { workflowRecord: { revisedPassage: 'r', snapshotAssignment: 's' } })), e), 'finding_records_invalid', /Issue record/);
  refused(gateResult.validateGateResult(withFinding(pre, issueFinding(pre, { workflowRecord: { revisedPassage: 'r', snapshotAssignment: 's', candidateIdentity: CANDIDATE } })), expectation('issue', pre)), 'finding_records_invalid', /Issue record/);
  refused(gateResult.validateGateResult(withFinding(corr, issueFinding(corr, { workflowRecord: { revisedPassage: 'r', candidateIdentity: CANDIDATE } })), e), 'schema_invalid', /snapshotAssignment/);
  // A pull-request result is refused on the Issue root, and an Issue result on the pull-request root.
  refused(gateResult.validateGateResult(envelope(prCorrelation('adversarial')), e), 'unknown_field');
  refused(gateResult.validateGateResult(envelope(corr), expectation('pr', prCorrelation('adversarial'))), 'unknown_field');
});

test('Issue #190 an assigned Issue finding is confirmed by issueSpec', () => {
  const corr = issueCorrelation('adversarial');
  const e = expectation('issue', corr, [{ findingId: 'ADV-190-OLD', blockerKey: 'K-1' }]);
  const assigned = issueFinding(corr, { findingId: 'ADV-190-OLD', origin: 'assigned', blockerKey: 'K-1', validationEvidence: 'v' });
  const confirmation = { findingId: 'ADV-190-OLD', gate: 'adversarial', issueSpec: corr.issueSpec, confirmation: 'confirmed', evidence: 'e' };
  const ok = gateResult.validateGateResult(envelope(corr, { findings: [assigned], confirmations: [confirmation] }), e);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  refused(gateResult.validateGateResult(envelope(corr, { findings: [assigned], confirmations: [{ ...confirmation, issueSpec: '2'.repeat(64) }] }), e), 'confirmation_records_invalid', /gate\/head/);
  const { issueSpec: _omit, ...unbound } = confirmation;
  refused(gateResult.validateGateResult(envelope(corr, { findings: [assigned], confirmations: [{ ...unbound, headOid: OID }] }), e), 'unknown_field', /unknown headOid/);
});

test('Issue #190 the pull-request root and version 1 behave as they did', () => {
  // No expectation: the envelope is still checked first, with the same codes.
  assert.equal(gateResult.validateGateResult({ schemaVersion: 2 }, null).error.code, 'schema_invalid');
  assert.equal(gateResult.validateGateResult(envelope(prCorrelation('adversarial')), null).error.code, 'invalid_request');
  // Several mismatches name the first in the pull-request field order, as before.
  const pr = prCorrelation('adversarial');
  refused(gateResult.validateGateResult(envelope({ ...pr, baseOid: 'c'.repeat(40), headOid: 'c'.repeat(40) }), expectation('pr', pr)), 'correlation_mismatch', /^baseOid mismatch$/);
  // Version 1 keeps the pull-request shape on both roots, and its Issue record still requires a candidate.
  const v1 = { ...envelope({ ...pr, gate: 'sol' }), schemaVersion: 1 };
  assert.equal(gateResult.validateGateResult(v1, expectation('issue', { ...pr, gate: 'sol' })).ok, true);
  refused(gateResult.validateGateResult({ ...v1, correlation: { ...v1.correlation, headOid: 'c'.repeat(40) } }, expectation('issue', { ...pr, gate: 'sol' })), 'correlation_mismatch', /^headOid mismatch$/);
  const v1Finding = { ...issueFinding({ gate: 'sol', issueSpec: SHA }, { findingId: 'SOL-190-A' }), issueSpec: undefined, headOid: OID };
  delete v1Finding.issueSpec;
  refused(gateResult.validateGateResult({ ...v1, verdict: 'FIX BEFORE MERGE', findings: [v1Finding] }, expectation('issue', { ...pr, gate: 'sol' })), 'finding_records_invalid', /Issue record/);
  v1Finding.workflowRecord = { candidateIdentity: 'candidate-1', revisedPassage: 'r', snapshotAssignment: 's' };
  assert.equal(gateResult.validateGateResult({ ...v1, verdict: 'FIX BEFORE MERGE', findings: [v1Finding] }, expectation('issue', { ...pr, gate: 'sol' })).ok, true);
});

test('Issue #190 an Issue expectation is built from the Issue correlation alone', () => {
  const built = helpers.buildGateExpectation(expectation('issue', issueCorrelation('decision-drift')));
  assert.equal(built.ok, true, JSON.stringify(built.error));
  refused(helpers.buildGateExpectation(expectation('issue', { ...issueCorrelation('decision-drift'), baseOid: 'b'.repeat(40) })), 'unknown_field', /unknown baseOid/);
  refused(helpers.buildGateExpectation(expectation('issue', prCorrelation('decision-drift'))), 'unknown_field');
  refused(helpers.buildGateExpectation(expectation('pr', issueCorrelation('safety'))), 'unknown_field');
  refused(helpers.buildGateExpectation(expectation('issue', issueCorrelation('safety'))), 'gate_outside_root');
});

// An Issue gate launch, end to end: the expectation, the composed launch, and the child's result read from a runner record.
function issueVolatile(gate, over = {}) {
  return {
    target: { repository: 'o/r', number: 190, mode: 'review-only', gate },
    fingerprints: { issue_spec: ISSUE_SPEC, snapshot: 'd'.repeat(64) },
    body: 'body', languageProfile: 'conversation: ja; GitHub issue / pull request: en', acceptanceCriteria: ['AC1'],
    history: { unresolved: [], reopened: [], settled: [] },
    ...(gate === 'adversarial' ? { decisions: [], comments: [] } : {}),
    ...over,
  };
}
function issueLaunch(dir, gate, volatile = issueVolatile(gate), corr = issueCorrelation(gate)) {
  const built = helpers.buildGateExpectation(expectation('issue', corr));
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const expectationPath = path.join(dir, `${gate}.json`);
  fs.writeFileSync(expectationPath, `${JSON.stringify(built.data.expected, null, 2)}\n`);
  return { expectationPath, launch: helpers.buildGateLaunch({ expectation: built.data, expectationPath, volatile }) };
}
function runRecord(root, envelopeValue, schema, agent) {
  const dir = path.join(root, RUN, 'structured-output', 'x'); fs.mkdirSync(dir, { recursive: true });
  const structuredOutputPath = path.join(dir, 'output.json'), structuredOutputSchemaPath = path.join(dir, 'schema.json');
  fs.writeFileSync(structuredOutputPath, JSON.stringify(envelopeValue));
  fs.writeFileSync(structuredOutputSchemaPath, JSON.stringify(schema));
  fs.writeFileSync(path.join(root, RUN, 'status.json'), JSON.stringify({ runId: RUN, state: 'complete', steps: [{ agent, status: 'complete', structuredOutputPath, structuredOutputSchemaPath }] }));
}

test('Issue #190 an Issue gate is launched and its result read with the role\'s packaged schema', () => {
  const dir = temp('i190-launch-');
  try {
    for (const [gate, role] of [['adversarial', 'tidd-adversarial-reviewer'], ['decision-drift', 'tidd-drift-reviewer']]) {
      const { expectationPath, launch } = issueLaunch(dir, gate);
      assert.equal(launch.ok, true, `${gate}: ${JSON.stringify(launch.error)}`);
      assert.equal(launch.data.request.agent, role);
      const payload = fs.readFileSync(launch.data.payloadPath, 'utf8');
      assert.match(payload, /"issueSpec": "e{64}"/, `${gate}: the payload carries the Issue correlation`);
      assert.doesNotMatch(payload, /"headOid"|"baseOid"|"headBranch"/, `${gate}: and no pull-request field`);
      const root = temp('i190-runs-');
      try {
        runRecord(root, envelope(issueCorrelation(gate)), JSON.parse(readText(`agents/${role}.md`).split('\n').find((l) => l.startsWith('outputSchema:')).slice('outputSchema:'.length)), role);
        const read = helpers.readGateResult({ runId: RUN, runsRoot: root, expectationPath });
        assert.equal(read.ok, true, `${gate}: ${JSON.stringify(read.error)}`);
        assert.equal(read.data.verdict, 'MERGE');
        // A child that ran with a schema the package does not ship is refused, as before.
        runRecord(root, envelope(issueCorrelation(gate)), { ...gateResult.ISSUE_SCHEMA, required: [] }, role);
        refused(helpers.readGateResult({ runId: RUN, runsRoot: root, expectationPath }), 'schema_transcription_mismatch');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #190 an Issue volatile target names no pull-request field, and its issue_spec is the correlation\'s', () => {
  const dir = temp('i190-volatile-');
  try {
    for (const [field, value] of [['baseOid', 'b'.repeat(40)], ['headOid', OID], ['headBranch', 'b'], ['headRepository', 'o/r']]) {
      const { launch } = issueLaunch(dir, 'decision-drift', issueVolatile('decision-drift', { target: { repository: 'o/r', number: 190, mode: 'review-only', gate: 'decision-drift', [field]: value } }));
      refused(launch, 'volatile_unknown_field', new RegExp(`target\\.${field}`));
    }
    refused(issueLaunch(dir, 'decision-drift', issueVolatile('decision-drift', { fingerprints: { issue_spec: SHA, snapshot: 'd'.repeat(64) } })).launch, 'invalid_request', /fingerprints\.issue_spec disagrees with the expectation on issueSpec/);
    // An Issue history record is an Issue finding record: it binds by issueSpec and names no head.
    const settled = (record) => issueVolatile('decision-drift', { history: { unresolved: [], reopened: [], settled: [record] } });
    assert.equal(issueLaunch(dir, 'decision-drift', settled({ findingId: 'DRIFT-1', issueSpec: ISSUE_SPEC, workflowRecord: { snapshotAssignment: 's' } })).launch.ok, true);
    refused(issueLaunch(dir, 'decision-drift', settled({ findingId: 'DRIFT-1', headOid: OID })).launch, 'volatile_unknown_field', /history\.settled\[\]\.headOid/);
    refused(issueLaunch(dir, 'decision-drift', settled({ findingId: 'DRIFT-1', workflowRecord: { sourceKind: 'gate' } })).launch, 'volatile_unknown_field', /workflowRecord\.sourceKind/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #190 the Issue Skill composes through the packaged helpers and names the packaged launch identity', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  assert.ok(skill.includes('Every Issue gate launch is composed by packaged `build_gate_launch` from the expectation packaged `build_gate_expectation` builds, and every result is read by packaged `gate_result_read` and validated by `gate_result_validate` (CL-D120).'));
  assert.ok(skill.includes('No packaged helper derives the Issue `contractInput` or `snapshotFingerprint` yet: the parent supplies both until the Issue driver does (#190).'));
  for (const gone of ['run nonce', 'tidd-issue-gate-v1', 'attempt_seq', 'physical-attempt sequence', 'allocate physical identities', 'Physical-attempt allocation']) assert.equal(skill.includes(gone), false, `the Skill no longer names ${gone}`);
  assert.ok(skill.includes('A retry keeps its gate\'s `invocation` but returns a new runner run id, and the earlier run id expires.'));
  assert.ok(skill.includes('Read and consume each run id exactly once, a refused read included,'));
  assert.ok(skill.includes('before every physical Sol or Terra launch'), 'the launch sentence names the Issue gates (CL-D121)');
  assert.ok(readText('skills/closed-loop-shared/references/gate-contract.md').includes('Under envelope schema version 2 each root has its own closed correlation (CL-D120).'));
});

test('Issue #190 CL-D120 records the decision, and the records it narrows say so', () => {
  const record = sectionOf(readContract(), '## CL-D120 — Gate result schema version 2 carries an Issue correlation beside the pull-request one');
  assert.ok(record, 'CL-D120 is in the contract');
  assert.match(record, /issues\/190#issuecomment-6233941786/);
  assert.ok(Buffer.byteLength(readText('contract/CL-D120.md')) < 8000);
  assert.deepEqual(readManifest().clauses.filter((c) => c.marker === 'CL-D120').map((c) => c.id), ['CL-D120-record', 'CL-D120-schema', 'CL-D120-envelope', 'CL-D120-read', 'CL-D120-skill', 'CL-D120-contract']);
  for (const [file, note] of [
    ['contract/CL-D31.md', '#190 later replaced the run nonce and the physical-attempt sequence with the packaged launch identity'],
    ['contract/CL-D32.md', '#190 later replaced the nonce and the physical-attempt correlation with the packaged launch identity'],
    ['contract/CL-D37.md', '#190 later reset the per-file smoke alarm from 30,000 to 32,000 bytes for every helper file, prompted by `helpers/launch.js`'],
    ['contract/CL-D90.md', '#190 later gave each gate role the schema of the roots its gate reviews'],
  ]) {
    assert.ok(readText(file).includes(note), `${file}: ${note}`);
    assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
  }
  assert.match(readText('test/issue-59-helper-surface.test.js'), /^const PER_FILE_SMOKE_ALARM = 32000; \/\/ #190 reviewed reset from 30,000 \(CL-D37\)/m);
});

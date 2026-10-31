'use strict';

// Issue #322 (CL-D126): on tetsuh/hekatus PR #160 three of four Majors were counterexamples to a sentence of the pull-request
// body, every one anchored `criterion-anchored` to AC1, so each round stopped for a code change and the next round found
// the next input the sentence did not survive. The anchoring rule reached Sol only, a `reword` could be Major, and its
// correction was "an owner edit of the body" although corrections go in the timeline (CL-D108). Owner choice B: the
// Every-gate block carries the anchoring test, a pull-request-root `reword` is Minor only, its correction is a trusted
// timeline comment, and a recorded reword line is not carried as settled into later runs (CL-D110 narrowed).
//
// TDD provenance: behavioural RED — the validator admits a Major reword, the driver carries a recorded reword line.
const { test, assert, fs, path, crypto, drive, setup, state, setFixture, nextRequest, fakeGate, publishable, prComment } = require('./issue-196-review-driver.fixtures.js');
const { SCHEMA, SCHEMAS, ISSUE_SCHEMA, ROLE_SCHEMAS, validateGateResult } = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, sectionOf, readManifest, manifestSources, contractIndex, issueCorrelationOf } = require('./helpers');

const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const ANCHOR_SECTION = '### Finding anchoring and threat-model bound (AC-ANCHOR, CL-D34)';
const EVERY_GATE = '#### Every-gate invariant payload block (CL-D2)';
const SOL_ONLY = '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)';
const REACH = 'A finding is `criterion-anchored` only when the text of the named acceptance criterion, contract clause or fail-stop invariant reaches the cited input; a counterexample the named text does not reach, which falsifies a sentence of the pull-request body, is';
const SECTION_REACH = `${REACH} \`reword\` whatever feature it concerns (CL-D126).`;
const SECTION_REWORD = 'A claim that appears only in target-body prose and names none of the three is a `reword` finding: in a pull-request run, a `Minor` whose correction is a trusted conversation comment on the pull request that narrows or corrects the claim (CL-D108), never a code change, never a body edit and never an implementation blocker (CL-D126).';
const BLOCK_RULE = `${REACH} a \`reword\` finding, a \`Minor\` whose correction is a trusted conversation comment that narrows or corrects the claim, not a code change and not a body edit (CL-D126).`;
const SOL_RULE = 'a claim found only in target-body prose naming none of the three is a `reword` finding, in a pull-request run a `Minor` corrected by a trusted conversation comment that narrows or corrects the claim, not an implementation blocker (CL-D126)';
const RECORDS_RULE = '`reword` traces only to target-body prose; in a pull-request run it is a `Minor` whose disposition is `fixed`, meaning a trusted conversation comment narrows or corrects the claim (CL-D108), never a body edit, or `accepted-as-designed`; never an implementation blocker (CL-D126).';
const REVIEW_SUFFIX = '`${x.proposedDisposition} (reword, recorded under CL-D85; judged afresh next run, CL-D126)`';
const CLAUSES = 'contract/CL-D126.clauses.json';

// Validator fixtures: a Major reword on each root and version, with the record shape of its root.
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const prCorrelation = (gate) => ({ repository: 'o/r', number: 322, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) });
const expectation = (workflow, correlation) => ({ workflow, correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
const PR_RECORD = { sourceKind: 'gate', sourceId: 'a.js:1', authorIdentity: 'g', authorType: 'Bot', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'c' };
function majorReword(correlation, prefix, bind) {
  const finding = { findingId: `${prefix}-322-X`, origin: 'fresh', gate: correlation.gate, ...bind, raisedAgainstFingerprint: SHA, severity: 'Major', anchoring: 'reword', proposedDisposition: 'fixed',
    evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending', workflowRecord: bind.issueSpec ? { revisedPassage: 'revised', snapshotAssignment: 'snapshot A' } : PR_RECORD };
  return { schemaVersion: 2, correlation, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', readCompletely: true }], findings: [finding], confirmations: [], decisions: [], adversarialResults: [] };
}
// Sol confirms every assigned finding, reclassified as a body-only claim: a Minor reword, accepted as designed
// (ADV-323-001, PR #323 round 3). The published line must still carry the CL-D126 non-carry suffix.
function solConfirmingReword(runDir, runs) {
  const st = state(runDir), expected = JSON.parse(fs.readFileSync(st.pending.expectationPath, 'utf8')), c = expected.correlation;
  const findings = expected.assignedFindings.map((a) => ({ findingId: a.findingId, blockerKey: a.blockerKey, origin: 'assigned', gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity: 'Minor', anchoring: 'reword', proposedDisposition: 'accepted-as-designed',
    evidence: 'the body sentence overstates', impact: 'none', rationale: 'body-only claim', correction: 'narrow the claim in a timeline comment', transport: 'pending', validationEvidence: 'n/a',
    workflowRecord: { sourceKind: 'gate', sourceId: 'a.js:1', authorIdentity: 'g', authorType: 'Bot', observedHeadOid: c.headOid, fingerprint: c.snapshotFingerprint, semanticFingerprint: c.snapshotFingerprint } }));
  const confirmations = expected.assignedFindings.map((a) => ({ findingId: a.findingId, gate: c.gate, headOid: c.headOid, confirmation: 'confirmed', evidence: 'body-only' }));
  const envelope = { schemaVersion: 2, correlation: c, verdict: 'MERGE', evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations, decisions: [], adversarialResults: [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] };
  const runId = crypto.randomUUID(), dir = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope)); fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  fs.writeFileSync(path.join(runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: st.checkout, steps: [{ agent: 'tidd-adversarial-reviewer', status: 'complete', model: 'p/m:high', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
  return runId;
}
function rewordVariant(schema) {
  return schema.properties.findings.items.anyOf.find((v) => v.properties.anchoring && v.properties.anchoring.enum.join() === 'reword');
}
// The settled history the first convergence payload of a run carries (CL-D110).
function settledOf(runDir) {
  const payload = fs.readdirSync(runDir).find((f) => f.startsWith('gate-payload-convergence-1-'));
  return JSON.parse(fs.readFileSync(path.join(runDir, payload), 'utf8').split('## Volatile envelope\n\n```json\n')[1].split('\n```')[0]).history.settled;
}

test('Issue #322 AC1 the anchoring section and the Every-gate block state the criterion-reach test', () => {
  const contract = readText(GATE_CONTRACT);
  const section = sectionOf(contract, ANCHOR_SECTION);
  assert.ok(section.includes(SECTION_REACH), 'the anchoring section states when a finding is criterion-anchored');
  const block = sectionOf(contract, EVERY_GATE);
  assert.equal(block.split(BLOCK_RULE).length - 1, 1, 'the Every-gate block carries the rule once');
  assert.ok(block.indexOf('(CL-D108).') < block.indexOf(BLOCK_RULE), 'the rule follows the CL-D108 sentence');
  assert.ok(sectionOf(contract, SOL_ONLY).includes(SOL_RULE), 'the Sol-only block agrees');
  // The gate roles' agent definitions carry no rule text; they change only in the schema they transcribe (CL-D90).
  for (const role of Object.keys(ROLE_SCHEMAS)) {
    const text = readText(`agents/${role}.md`), frontmatter = text.slice(4, text.indexOf('\n---\n', 4));
    assert.equal(frontmatter.includes('CL-D126'), false, `${role} carries no rule text`);
    assert.deepEqual(JSON.parse(frontmatter.split('\n').find((line) => line.startsWith('outputSchema:')).slice('outputSchema:'.length).trim()), ROLE_SCHEMAS[role], `${role} transcribes the packaged schema`);
  }
});

test('Issue #322 AC2 a reword finding is corrected in the timeline, never by a body edit', () => {
  const contract = readText(GATE_CONTRACT);
  assert.ok(sectionOf(contract, ANCHOR_SECTION).includes(SECTION_REWORD));
  for (const gone of ['its correction is an owner edit of the body', 'corrected by owner body edit']) assert.equal(contract.includes(gone), false, `${JSON.stringify(gone)} no longer appears`);
  assert.ok(readText('skills/closed-loop-shared/references/records.md').includes(RECORDS_RULE), 'records.md states the Minor and the timeline correction');
});

test('Issue #322 AC3 the schema and the validator admit a pull-request-root reword at Minor only', () => {
  assert.deepEqual(rewordVariant(SCHEMA).properties.severity.enum, ['Minor'], 'the pull-request schema');
  assert.deepEqual(rewordVariant(ISSUE_SCHEMA).properties.severity.enum, ['Major', 'Minor'], 'the Issue schema is unchanged');
  assert.deepEqual(rewordVariant(SCHEMAS[1]).properties.severity.enum, ['Major', 'Minor'], 'version 1 stays verbatim');
  // The validator: the bound holds on the version-2 pull-request root only.
  const pr = prCorrelation('safety'), v2 = validateGateResult(majorReword(pr, 'SAFETY', { headOid: OID }), expectation('pr', pr));
  assert.equal(v2.ok, false); assert.equal(v2.error.code, 'finding_records_invalid'); assert.match(v2.error.message, /SAFETY-322-X: reword/);
  const legacy = prCorrelation('terra'), v1 = validateGateResult({ ...majorReword(legacy, 'TERRA', { headOid: OID }), schemaVersion: 1 }, expectation('pr', legacy));
  assert.equal(v1.ok, true, `a version-1 Major reword is accepted as before: ${JSON.stringify(v1.error)}`);
  const issue = issueCorrelationOf(prCorrelation('decision-drift')), onIssue = validateGateResult(majorReword(issue, 'DRIFT', { issueSpec: issue.issueSpec }), expectation('issue', issue));
  assert.equal(onIssue.ok, true, `an Issue-root Major reword is accepted as before: ${JSON.stringify(onIssue.error)}`);
  // Through the driver: a Major reword is refused as a finding-record failure, relaunched once, then the run ends BLOCKED.
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const major = { verdict: 'FIX', severity: 'Major', anchoring: 'reword', disposition: 'fixed' };
  const first = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, major)], t.e);
  assert.equal(nextRequest(first.stdout)?.agent, 'tidd-convergence-reviewer', `relaunched once: ${first.stdout}${first.stderr}`);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, major)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED', s.reason);
  assert.match(s.reason, /reword/);
});

test('Issue #322 AC4 the record, its clauses, the index, the re-pointed CL-D34 pins and the README agree', () => {
  const record = readText('contract/CL-D126.md');
  assert.ok(record.startsWith('## CL-D126 — '));
  for (const needle of ['*Owner choice:* Option B', 'is `reword` whatever feature it concerns', 'is not carried as settled', 'The Issue root is unchanged']) assert.ok(record.includes(needle), `the record states ${JSON.stringify(needle)}`);
  assert.ok(contractIndex().files.includes('contract/CL-D126.md'), 'CONTRACT.md lists the record');
  assert.ok(manifestSources().includes(CLAUSES), 'the clause file is a manifest source');
  const ids = readManifest().clauses.filter((c) => c.id.startsWith('CL-D126')).map((c) => c.id);
  for (const id of ['CL-D126-record', 'CL-D126-anchor', 'CL-D126-every-gate', 'CL-D126-sol', 'CL-D126-classes', 'CL-D126-validator', 'CL-D126-review', 'CL-D126-readme', 'CL-D126-tests']) assert.ok(ids.includes(id), `${id} is pinned`);
  const d34 = JSON.parse(readText('contract/CL-D34.clauses.json')).clauses;
  assert.ok(d34.find((c) => c.id === 'CL-D34-anchor').requires.includes('never a code change, never a body edit and never an implementation blocker'), 'CL-D34-anchor is re-pointed');
  assert.ok(d34.find((c) => c.id === 'CL-D34-payload').requires.includes('`reword` finding, in a pull-request run a `Minor` corrected by a trusted conversation comment that narrows or corrects the claim, not an implementation blocker'), 'CL-D34-payload is re-pointed');
  for (const c of d34) for (const r of c.requires) assert.equal(/owner (body )?edit/.test(r), false, `${c.id} no longer pins a body edit`);
  assert.ok(readText('README.md').includes('body-only absolute wording is a `reword` finding, a Minor whose correction is a trusted conversation comment that narrows or corrects the claim (CL-D126)'), 'the README sentence');
});

test('Issue #322 AC5 a recorded reword line is published with a suffix a later run does not carry as settled', () => {
  assert.ok(readText('skills/closed-loop-pr/driver/review.js').includes(REVIEW_SUFFIX), 'review.js publishes the reword suffix');
  // Run 1: convergence raises a Minor reword, recorded; Sol and Terra return MERGE; the round is published.
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const minor = { verdict: 'FIX', severity: 'Minor', anchoring: 'reword', disposition: 'fixed' };
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, minor)], t.e).stdout)?.agent, 'tidd-adversarial-reviewer', 'a Minor reword is recorded and the run proceeds');
  for (let i = 0; i < 2; i += 1) drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const { s, body } = publishable(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  const line = '  CONV-7-X: fixed (reword, recorded under CL-D85; judged afresh next run, CL-D126)';
  assert.ok(body.includes(`\n${line}\n`), `the published block carries the line:\n${body}`);
  // Run 2 reads that round as a trusted earlier round: the recorded Minor of CL-D85 is carried, the reword line is not.
  const t2 = setup();
  const published = body.replace(line, `${line}\n  CONV-7-002: fixed (recorded under CL-D85)`);
  setFixture(t2, { prComments: [prComment(501, { body: published, author_association: 'OWNER' })] });
  const r = drive(t2.start, t2.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', r.stdout + r.stderr);
  assert.deepEqual(settledOf(t2.runDir).map((x) => x.findingId), ['CONV-7-002'], 'only the CL-D85 line is carried');
});

test('Issue #322 AC5 a reword Sol confirms on an assigned finding is published with the non-carry suffix too', () => {
  // ADV-323-001 (PR #323 round 3): `settled(x)` was tested before the reword branch, so a confirmed, accepted-as-designed
  // reword was published as `(confirmed by sol)`, a line the settled pattern of `earlierRounds` matches.
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  // Convergence at its cap with an open finding hands the candidate to Sol with that finding assigned (CL-D62): two
  // new conversation comments rerun convergence on the unchanged head (DEC-109), so the third invocation is the cap.
  for (const n of [1, 2]) { setFixture(t, { prComments: Array.from({ length: n }, (_, i) => prComment(i + 1)) }); drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); }
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e).stdout)?.agent, 'tidd-adversarial-reviewer', 'the open convergence finding is assigned to Sol');
  const sol = drive(['result', '--run-dir', t.runDir, '--run-id', solConfirmingReword(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(sol.stdout)?.agent, 'tidd-safety-reviewer', `Sol confirmed the reclassified finding: ${sol.stdout}${sol.stderr}`);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const { s, body } = publishable(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  const line = '  CONV-7-X: accepted-as-designed (reword, confirmed by sol; judged afresh next run, CL-D126)';
  assert.ok(body.includes(`\n${line}\n`), `the published block carries the line:\n${body}`);
  const t2 = setup();
  setFixture(t2, { prComments: [prComment(502, { body, author_association: 'OWNER' })] });
  assert.equal(nextRequest(drive(t2.start, t2.e).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.deepEqual(settledOf(t2.runDir).map((x) => x.findingId), [], 'the confirmed reword is not carried');
});

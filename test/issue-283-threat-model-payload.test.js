'use strict';

// Issue #283 (CL-D34). Exact PR autofix assumes five operator conditions cooperative, and the Sol-only block tells Sol
// that a counterexample needing one violated is a `follow-up`, but no payload named them, so Sol could not tell which
// conditions were assumed. `build_gate_launch` now adds the exact-autofix threat-model block to an exact-autofix Sol
// payload, and to no other (owner choice, issues/283#issuecomment-6232831468).

const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../skills/closed-loop-pr/helpers');
const { readContract, sectionOf, readManifest, issueCorrelationOf } = require('./helpers');
const autofixDriver = require('./issue-196-autofix-driver.fixtures');
const reviewDriver = require('./issue-196-review-driver.fixtures');

const { test, assert, readText, temp } = autofixDriver;
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const HEADING = '#### Exact-autofix threat-model payload block (CL-D34)';
const SOL_ONLY = '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)';
const D34_HEADING = '## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model';
const D117_HEADING = '## CL-D117 — The remaining clause pins of the autofix addendum move to the code and the records';
const CHOICE = 'https://github.com/tetsuh/pi-tidd-agents/issues/283#issuecomment-6232831468';
// The five conditions as CL-D34 states them.
const CONDITIONS = [
  '`TMPDIR`/`TEMP`/`TMP` and any supplied `runRoot` resolve outside the operator checkout',
  'local, worktree, global, and system Git configuration is not mutated by a third party during the run',
  'the filesystem is not concurrently hostile between one discrete no-follow observation and the next Git operation',
  '`gh` and GitHub return schema-valid responses for supported endpoints',
  'the operator does not run another writer against the same checkout or workspace',
];
const block = () => sectionOf(readText(GATE_CONTRACT), HEADING);
const count = (text, part) => text.split(part).length - 1;

// The Sol payloads a driver run wrote, read from the run directory where the launch put them.
function solPayloads(runDir) {
  return fs.readdirSync(runDir).filter((f) => f.startsWith('gate-payload-adversarial-')).map((f) => fs.readFileSync(path.join(runDir, f), 'utf8'));
}

test('Issue #283 the threat-model block states the five conditions CL-D34 records', () => {
  const model = block();
  assert.ok(model, 'the exact-autofix threat-model block is in the gate contract');
  assert.match(model, /^This run is exact PR `autofix`\. Its threat model assumes these operator conditions cooperative: /m);
  const record = sectionOf(readContract(), D34_HEADING);
  for (const condition of CONDITIONS) {
    assert.ok(model.includes(condition), `the block states: ${condition}`);
    assert.ok(record.includes(condition), `CL-D34 still states: ${condition}`);
  }
  assert.match(model, /Helpers that detect a violated assumption still fail closed\./);
  // The exception is the Sol-only block's rule, so the two cannot disagree.
  assert.match(model, /classified by the Sol-only block's threat-model rule: it is `follow-up` unless an acceptance criterion, contract clause, or fail-stop invariant names that condition\./);
  // It sits after the Sol-only block, so that block, its digest and its pins are unchanged.
  const text = readText(GATE_CONTRACT);
  assert.ok(text.indexOf(SOL_ONLY) < text.indexOf(HEADING), 'the block follows the Sol-only block');
});

test('Issue #283 the packaged autofix driver\'s first Sol payload carries the threat model, once, after the Sol-only block', () => {
  // Every gate launch of the driver is composed at one site, with the mode the block is keyed on, so a later Sol payload
  // is composed as the first one is.
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.equal(count(driver, "run.op('build_gate_launch'"), 1, 'one launch site');
  assert.ok(driver.includes("headOid: t.headOid, mode: 'autofix', gate },"), 'it states the autofix mode');
  const t = autofixDriver.setup();
  assert.equal(autofixDriver.drive(t.start, t.env).status, 0);
  // Convergence goes first; its MERGE launches Sol.
  for (let i = 0; i < 3 && solPayloads(t.runDir).length === 0; i += 1) autofixDriver.drive(['result', '--run-dir', t.runDir, '--run-id', autofixDriver.fakeGate(t.runDir, t.runs)], t.env);
  const payloads = solPayloads(t.runDir);
  assert.equal(payloads.length, 1, 'the run launched Sol');
  for (const payload of payloads) {
    for (const condition of CONDITIONS) assert.ok(payload.includes(condition), `the payload states: ${condition}`);
    assert.equal(count(payload, block()), 1, 'the block is copied verbatim, once');
    assert.ok(payload.indexOf(sectionOf(readText(GATE_CONTRACT), SOL_ONLY)) < payload.indexOf(block()), 'after the Sol-only block');
  }
  // The launch reports the block it read, with its digest, like every other block.
  const results = fs.readdirSync(t.runDir).filter((f) => f.endsWith('-build_gate_launch.result.json'));
  const sol = results.map((f) => JSON.parse(fs.readFileSync(path.join(t.runDir, f), 'utf8'))).find((r) => r.data.blocks.some((b) => b.heading === SOL_ONLY));
  assert.deepEqual(sol.data.blocks.map((b) => b.heading).slice(0, 3), ['#### Every-gate invariant payload block (CL-D2)', SOL_ONLY, HEADING]);
});

test('Issue #283 a review-only Sol payload of the packaged review driver declares no threat model', () => {
  const t = reviewDriver.setup();
  assert.equal(reviewDriver.drive(t.start, t.e).status, 0);
  for (let i = 0; i < 3 && solPayloads(t.runDir).length === 0; i += 1) reviewDriver.throughGates(t, 1);
  const payloads = solPayloads(t.runDir);
  assert.ok(payloads.length > 0, 'the run launched Sol');
  for (const payload of payloads) {
    assert.ok(payload.includes(sectionOf(readText(GATE_CONTRACT), SOL_ONLY)), 'it still carries the Sol-only block');
    assert.equal(payload.includes(HEADING), false, 'no threat-model heading');
    for (const condition of CONDITIONS) assert.equal(payload.includes(condition), false, `no condition: ${condition}`);
  }
});

// build_gate_launch, directly: the block goes to PR Sol in autofix only; Terra, convergence, review-only and Issue
// Sol never receive it.
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const CREATED = Object.freeze({ kind: 'linked', path: '/tmp/pi-autofix-helper-test/workspace', root: '/tmp/pi-autofix-helper-test', head: OID, tree: 'b'.repeat(40), cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' } });
function launch(workflow, gate, mode) {
  const prCorrelation = { repository: 'o/r', number: 283, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
  const correlation = workflow === 'pr' ? prCorrelation : issueCorrelationOf(prCorrelation);  // CL-D120
  const built = helpers.buildGateExpectation({ workflow, correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const dir = temp('issue-283-launch-');
  try {
    const expectationPath = path.join(dir, `${gate}.json`);
    fs.writeFileSync(expectationPath, `${JSON.stringify(built.data.expected, null, 2)}\n`);
    const volatile = {
      target: { repository: 'o/r', number: 283, mode, gate, ...(workflow === 'pr' ? { baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' } : {}) },
      fingerprints: workflow === 'pr' ? { issue_spec: SHA, pr_base: 'b'.repeat(40), pr_tree: 'c'.repeat(40), pr_head: OID, pr_diff: SHA, pr_commits: SHA, snapshot: 'd'.repeat(64) } : { issue_spec: correlation.issueSpec, snapshot: 'd'.repeat(64) },
      body: 'body', languageProfile: 'conversation: ja; GitHub issue / pull request: en', acceptanceCriteria: ['AC1'], history: { unresolved: [], reopened: [], settled: [] },
      ...(workflow === 'pr' ? { diff: 'diff --git a/a b/a\n' } : {}),
      ...(gate === 'adversarial' ? { decisions: [], comments: [] } : {}),
    };
    const result = helpers.buildGateLaunch({ expectation: built.data, expectationPath, volatile, ...(mode === 'autofix' ? { created: CREATED } : {}) });
    assert.equal(result.ok, true, `${workflow}/${gate}/${mode}: ${JSON.stringify(result.error)}`);
    return { payload: fs.readFileSync(result.data.payloadPath, 'utf8'), headings: result.data.blocks.map((b) => b.heading) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Issue #283 build_gate_launch adds the block to exact-autofix PR Sol and to no other launch', () => {
  const sol = launch('pr', 'adversarial', 'autofix');
  for (const condition of CONDITIONS) assert.ok(sol.payload.includes(condition), `the payload states: ${condition}`);
  assert.equal(count(sol.payload, block()), 1);
  assert.equal(sol.headings.filter((h) => h === HEADING).length, 1);
  for (const [workflow, gate, mode] of [['pr', 'adversarial', 'review-only'], ['issue', 'adversarial', 'autofix'], ['pr', 'safety', 'autofix'], ['pr', 'convergence', 'autofix'], ['pr', 'safety', 'review-only'], ['issue', 'adversarial', 'review-only']]) {
    const { payload, headings } = launch(workflow, gate, mode);
    assert.equal(payload.includes(HEADING) || payload.includes(CONDITIONS[0]), false, `${workflow}/${gate}/${mode}: no threat model`);
    assert.equal(headings.includes(HEADING), false, `${workflow}/${gate}/${mode}: no threat-model block`);
  }
});

test('Issue #283 the records name the payload source, retire the gap, and state the block where the blocks are listed', () => {
  const record = sectionOf(readContract(), D34_HEADING);
  assert.ok(record.includes(`#283 later gave this list to Sol (owner choice, ${CHOICE}): \`build_gate_launch\` adds the \`${HEADING}\` of \`${GATE_CONTRACT}\`, which states the same five conditions, to every exact PR \`autofix\` Sol payload and to no review-only or Issue payload.`));
  assert.equal(record.includes('No packaged driver gives this list to a gate'), false, 'the gap sentence is retired');
  assert.equal(record.includes('(#283): recorded and not closed'), false, 'the gap is no longer recorded as open');
  // CL-D117 keeps its list of the six gaps as decided, and says #283 later closed the first.
  const d117 = sectionOf(readContract(), D117_HEADING);
  assert.ok(d117.includes(`#283 later closed the first of the six gaps (owner choice, ${CHOICE}): exact PR \`autofix\` Sol now receives the threat model (CL-D34).`));
  assert.ok(readText('contract/CL-D2.md').includes('#283 later added a third nested block, the exact-autofix threat-model block, which only an exact PR `autofix` Sol invocation receives (CL-D34).'));
  assert.ok(readText(GATE_CONTRACT).includes('Every exact PR `autofix` Sol route also uses the exact-autofix threat-model block, and no other route carries it.'));
  assert.ok(readText('skills/closed-loop-pr/SKILL.md').includes('the shared exact-autofix threat-model payload block verbatim for every exact-autofix Sol and for no review-only Sol (CL-D34)'));
  const clauses = readManifest().clauses;
  assert.equal(clauses.find((c) => c.id === 'CL-D34-threat-model-payload')?.section, HEADING);
  assert.deepEqual(clauses.find((c) => c.id === 'CL-D34-threat-model-launch')?.files, ['skills/closed-loop-pr/helpers/launch.js']);
  for (const file of ['contract/CL-D34.md', 'contract/CL-D117.md', 'contract/CL-D2.md']) assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
});

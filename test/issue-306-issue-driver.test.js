'use strict';

// Issue #306 (CL-D122), step 2b of #190. The Issue review-and-draft round was prose: the parent composed every gate and
// supplied the Issue contractInput and snapshotFingerprint by hand (CL-D120). The packaged Issue driver runs it: Sol, then
// Terra (CL-D121), through the packaged helpers, lighter than the pull-request round by the owner's choice
// (issues/190#issuecomment-6243884276): the gates' required evidence is the Issue's own two identities, the snapshot is
// read once, the round stops at the first open finding, and nothing is published.
//
// TDD provenance: behavioural RED — no packaged Issue driver exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { repoPath, readText, readContract, sectionOf, readManifest } = require('./helpers');

const DRIVER = repoPath('skills/closed-loop-pr/driver/issue.js');
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const SPEC = 'Spec.\n\n## Acceptance criteria\n\n- AC1: the module exports two.\n';
const issueRecord = (over = {}) => ({ number: 5, state: 'open', title: 't', body: SPEC, updated_at: '2026-10-18T00:00:00Z', labels: [], user: { login: 'o' }, repository_url: 'https://api.github.com/repos/o/r', ...over });
const comment = (id, over = {}) => ({ id, html_url: `u${id}`, user: { login: 'someone', type: 'User' }, author_association: 'MEMBER', created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', body: `comment ${id}`, ...over });

// A `gh` on PATH that answers for Issue #5 from a fixture: its record and its comments; anything else is an unexpected call.
function fakeGh(fixture) {
  const bin = temp('i306-bin-'), file = path.join(bin, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const f = JSON.parse(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'));
const args = process.argv.slice(2), endpoint = args[args.length - 1];
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args.includes('repo') && args.includes('view')) out({ nameWithOwner: 'o/r' });
if (args[0] === 'api' && endpoint === 'repos/o/r/issues/5') out(f.issue);
if (args[0] === 'api' && endpoint.startsWith('repos/o/r/issues/5/comments')) out(args.includes('--slurp') ? [f.comments || []] : (f.comments || []));
process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(9);
`, { mode: 0o755 });
  return { bin, file };
}
function setup(fixture = {}) {
  const gh = fakeGh({ issue: issueRecord(), comments: [], ...fixture }), runs = temp('i306-runs-'), runDir = path.join(temp('i306-run-'), 'run');
  const e = { ...process.env, PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs, XDG_CONFIG_HOME: temp('i306-xdg-') };
  return { e, runs, runDir, fixture: gh.file, start: ['start', '--issue', '5', '--repo', 'o/r', '--checkout', temp('i306-checkout-'), '--run-dir', runDir] };
}
const drive = (t, args) => spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: t.e, timeout: 120000 });
const state = (t) => JSON.parse(fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8'));
const nextRequest = (stdout) => { const lines = stdout.split('\n'), i = lines.findIndex((l) => l.startsWith('NEXT:')); return i < 0 ? null : JSON.parse(lines[i + 1]); };
const setFixture = (t, patch) => fs.writeFileSync(t.fixture, JSON.stringify({ ...JSON.parse(fs.readFileSync(t.fixture, 'utf8')), ...patch }));

// The gate child, faked: a completed run whose structured output is a validator-accepted Issue envelope, declared with
// the role's packaged schema.
function fakeGate(t, { verdict = 'MERGE', severity = 'Major', anchoring = 'criterion-anchored', decision = false } = {}) {
  const { ROLE_SCHEMAS } = require('../skills/closed-loop-pr/helpers/gate-result');
  const st = state(t), expected = JSON.parse(fs.readFileSync(st.pending.expectationPath, 'utf8')), c = expected.correlation;
  const agent = { adversarial: 'tidd-adversarial-reviewer', 'decision-drift': 'tidd-drift-reviewer' }[c.gate];
  const prefix = { adversarial: 'ADV', 'decision-drift': 'DRIFT' }[c.gate];
  const findings = verdict === 'MERGE' || decision ? [] : [{ findingId: `${prefix}-5-X`, origin: 'fresh', gate: c.gate, issueSpec: c.issueSpec, raisedAgainstFingerprint: c.snapshotFingerprint, severity, anchoring,
    ...(anchoring === 'criterion-anchored' ? { anchor: 'AC1' } : {}), proposedDisposition: 'fixed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 't', workflowRecord: { revisedPassage: 'p', snapshotAssignment: 's' } }];
  const decisions = decision ? [{ decisionId: 'DEC-5-001', kind: 'contract', targetAndRevision: 'Issue #5', question: 'q', options: 'a or b', recommendation: 'a', rationale: 'r', validity: 'v', status: 'pending' }] : [];
  const envelope = { schemaVersion: 2, correlation: c, verdict: decision ? 'NEEDS DECISION' : verdict, evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations: [], decisions,
    adversarialResults: c.gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [] };
  const runId = crypto.randomUUID(), dir = path.join(t.runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(ROLE_SCHEMAS[agent]));
  fs.writeFileSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: st.checkout, steps: [{ agent, status: 'complete', model: 'prov/model-x', thinking: 'high', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
  return runId;
}
const result = (t, options) => drive(t, ['result', '--run-dir', t.runDir, '--run-id', fakeGate(t, options)]);

test('Issue #306 the driver runs Sol, then Terra, with the Issue correlation and ends IMPLEMENTATION_READY', () => {
  const t = setup({ comments: [comment(11), comment(12, { user: { login: 'bot', type: 'Bot' }, author_association: 'NONE' })] });
  const started = drive(t, t.start);
  assert.equal(started.status, 0, started.stderr);
  const sol = nextRequest(started.stdout);
  assert.equal(sol.agent, 'tidd-adversarial-reviewer');
  assert.equal(sol.outputSchema, undefined, 'the schema is the agent definition\'s');
  const s = state(t), expected = JSON.parse(fs.readFileSync(s.pending.expectationPath, 'utf8'));
  // The Issue correlation, with the contractInput and snapshotFingerprint the driver derived.
  const files = ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
  const contract = sha(Buffer.from(files.map((file) => `${file}\n${readText(file).replace(/\r\n?/g, '\n')}`).join('\n'), 'utf8'));
  assert.deepEqual(expected.correlation, { repository: 'o/r', number: 5, lifecycle: 'open', gate: 'adversarial', invocation: 1, contractInput: contract, snapshotFingerprint: s.fingerprints.snapshot, issueSpec: s.fingerprints.issue_spec });
  assert.match(s.fingerprints.snapshot, /^[0-9a-f]{64}$/);
  // The Issue's own two identities are the required evidence; no file is required.
  assert.deepEqual(expected.requiredEvidence, [{ source: 'github:issue:5:spec', kind: 'github', identity: s.fingerprints.issue_spec }, { source: 'snapshot:issue:5', kind: 'snapshot', identity: s.fingerprints.snapshot }]);
  // issue_spec is the helper's: the body and the authoritative comment, never the bot's.
  const { issueSpecFingerprint } = require('../skills/closed-loop-pr/helpers/fingerprints');
  assert.equal(s.fingerprints.issue_spec, issueSpecFingerprint({ body: SPEC, comments: [comment(11)] }));
  assert.notEqual(s.fingerprints.issue_spec, issueSpecFingerprint({ body: SPEC, comments: [] }), 'the authoritative comment counts');
  const terra = result(t);
  assert.equal(terra.status, 0, terra.stdout + terra.stderr);
  assert.equal(nextRequest(terra.stdout).agent, 'tidd-drift-reviewer');
  assert.equal(JSON.parse(fs.readFileSync(state(t).pending.expectationPath, 'utf8')).correlation.gate, 'decision-drift');
  const done = result(t);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const end = state(t);
  assert.equal(end.state, 'IMPLEMENTATION_READY');
  assert.deepEqual(end.gateLog.map((g) => [g.gate, g.verdict]), [['adversarial', 'MERGE'], ['decision-drift', 'MERGE']]);
  // A local draft with the Issue status block; nothing to publish.
  const draft = fs.readFileSync(end.draft, 'utf8');
  for (const line of ['target: o/r#5', 'state: IMPLEMENTATION_READY', 'active_gate: none', `issue_spec: ${end.fingerprints.issue_spec}`, 'rounds: sol 1/3, terra 1/3', 'resolved: tidd-adversarial-reviewer prov/model-x:high; tidd-drift-reviewer prov/model-x:high', 'findings: none', 'pending_decisions: none', 'publication_grant: not-applicable']) assert.ok(draft.includes(`\n${line}\n`), line);
  assert.match(done.stdout, /^FINISHED comment=/m);
  assert.doesNotMatch(done.stdout, /PUBLISH=/);
  assert.deepEqual(fs.readdirSync(path.dirname(end.draft)), ['issue-review.md']);
});

test('Issue #306 an open finding or a pending decision stops the round for the owner before the next gate', () => {
  for (const options of [{ verdict: 'FIX BEFORE MERGE' }, { decision: true }]) {
    const t = setup();
    assert.equal(drive(t, t.start).status, 0);
    const stopped = result(t, options);
    assert.equal(stopped.status, 1, stopped.stderr);
    const s = state(t);
    assert.equal(s.state, 'WAITING_FOR_OWNER', JSON.stringify(options));
    assert.equal(nextRequest(stopped.stdout), null, 'Terra is not launched');
    assert.equal(fs.readdirSync(t.runDir).some((f) => f.startsWith('expectation-decision-drift')), false);
    if (options.decision) assert.deepEqual(s.pendingDecisions, ['DEC-5-001']);
    else {
      assert.equal(s.nextAction, 'the owner revises the Issue, then a fresh run');
      assert.ok(fs.readFileSync(s.draft, 'utf8').includes('\n  ADV-5-X: fixed (proposed; revision pending)\n'));
    }
  }
  // CL-D85's recorded Minors are the pull-request root's: on the Issue a Minor reword is a revision, so it stops too.
  const t = setup();
  drive(t, t.start);
  const reword = result(t, { verdict: 'FIX BEFORE MERGE', severity: 'Minor', anchoring: 'reword' });
  assert.equal(reword.status, 1, reword.stdout + reword.stderr);
  assert.equal(state(t).state, 'WAITING_FOR_OWNER');
  assert.equal(nextRequest(reword.stdout), null, 'Terra is not launched without Sol MERGE');
});

// CONV-307-AC1-SNAPSHOT-PROJECTION-TEST: the snapshot covers every comment, bots included, and the Issue's own state, while
// issue_spec keeps the CL-D9 authoritative subset.
test('Issue #306 the snapshot covers every comment and the Issue state; issue_spec only the authoritative text', () => {
  const fingerprints = (fixture) => { const t = setup(fixture); assert.equal(drive(t, t.start).status, 0); return state(t).fingerprints; };
  const base = fingerprints({});
  const bot = fingerprints({ comments: [comment(31, { user: { login: 'bot', type: 'Bot' }, author_association: 'NONE' })] });
  assert.equal(bot.issue_spec, base.issue_spec, 'a bot comment is not authoritative');
  assert.notEqual(bot.snapshot, base.snapshot, 'the snapshot covers it');
  assert.deepEqual(fingerprints({}), base, 'the same Issue gives the same snapshot');
  const human = fingerprints({ comments: [comment(33, { author_association: 'NONE' })] });
  assert.equal(human.issue_spec, base.issue_spec, 'a non-member comment is advisory');
  assert.notEqual(human.snapshot, base.snapshot, 'the snapshot covers it');
  // An edit to the bot comment's body alone, or its update time alone, changes the snapshot.
  for (const change of [{ body: 'edited' }, { updated_at: '2026-10-18T01:00:00Z' }]) {
    const edited = fingerprints({ comments: [comment(31, { user: { login: 'bot', type: 'Bot' }, author_association: 'NONE', ...change })] });
    assert.equal(edited.issue_spec, base.issue_spec);
    assert.notEqual(edited.snapshot, bot.snapshot, `an edited bot comment changes the snapshot: ${Object.keys(change)}`);
  }
  const labelled = fingerprints({ issue: issueRecord({ labels: [{ name: 'x' }] }) });
  assert.equal(labelled.issue_spec, base.issue_spec);
  assert.notEqual(labelled.snapshot, base.snapshot, 'the snapshot covers the Issue state');
  const authored = fingerprints({ comments: [comment(32)] });
  assert.notEqual(authored.issue_spec, base.issue_spec);
  assert.notEqual(authored.snapshot, base.snapshot);
});

test('Issue #306 each run id is read once, a refused read included', () => {
  const t = setup();
  drive(t, t.start);
  const unknown = crypto.randomUUID();
  const refused = drive(t, ['result', '--run-dir', t.runDir, '--run-id', unknown]);
  assert.ok(nextRequest(refused.stdout), `an unreadable result relaunches once: ${refused.stdout}${refused.stderr}`);
  // The same id, now holding a valid output, is expired.
  const valid = fakeGate(t);
  fs.renameSync(path.join(t.runs, 'async-subagent-runs', valid), path.join(t.runs, 'async-subagent-runs', unknown));
  const status = path.join(t.runs, 'async-subagent-runs', unknown, 'status.json');
  fs.writeFileSync(status, fs.readFileSync(status, 'utf8').split(valid).join(unknown));
  const again = drive(t, ['result', '--run-dir', t.runDir, '--run-id', unknown]);
  assert.equal(again.status, 1);
  assert.equal(state(t).state, 'BLOCKED');
  assert.match(state(t).reason, /was already read; a relaunch expires it/);
});

test('Issue #306 a moved Issue is refused, a missing --issue value is refused, and odd records still bind', () => {
  // A number that answers with another record (a transferred Issue) is refused before any run, and later in the round.
  const moved = setup({ issue: issueRecord({ number: 9 }) });
  const refused = drive(moved, moved.start);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /answers with another record \(#9\); the Issue moved/);
  const t = setup();
  drive(t, t.start);
  setFixture(t, { issue: issueRecord({ pull_request: { url: 'x' } }) });
  result(t);
  assert.equal(state(t).state, 'BLOCKED');
  assert.match(state(t).reason, /now answers with another record/);
  const bare = setup();
  const noValue = drive(bare, ['start', '--issue', '--repo', 'o/r', '--run-dir', bare.runDir]);
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--issue must be an Issue number/);
  // A body that opens with its Acceptance criteria section, and a null label, still bind and launch Sol.
  const odd = setup({ issue: issueRecord({ body: '## Acceptance criteria\n\n- AC1: it works.\n', labels: [null, { name: 'a' }, 'b'] }), comments: [comment('11'), comment(9)] });
  const started = drive(odd, odd.start);
  assert.equal(nextRequest(started.stdout)?.agent, 'tidd-adversarial-reviewer', started.stdout + started.stderr);
  assert.deepEqual(state(odd).acceptanceCriteria, ['AC1: it works.']);
});

test('Issue #306 an Issue without acceptance criteria stops before any gate, and a pull request or a closed Issue is refused', () => {
  const t = setup({ issue: issueRecord({ body: 'Spec without criteria.\n' }) });
  const stopped = drive(t, t.start);
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.equal(state(t).state, 'WAITING_FOR_OWNER');
  assert.match(state(t).reason, /no Acceptance criteria section/);
  assert.equal(nextRequest(stopped.stdout), null);
  assert.equal(fs.readdirSync(t.runDir).some((f) => f.startsWith('expectation-')), false);
  for (const [over, why] of [[{ pull_request: { url: 'x' } }, /is a pull request; use \/tidd-pr/], [{ state: 'closed' }, /is closed; only an open Issue is reviewed/]]) {
    const r = setup({ issue: issueRecord(over) });
    const refused = drive(r, r.start);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, why);
    assert.equal(fs.existsSync(path.join(r.runDir, 'state.json')), false, 'no run starts');
  }
});

test('Issue #306 a changed issue_spec before Terra or at readiness stops the round; a bot comment alone does not', () => {
  const t = setup();
  drive(t, t.start);
  setFixture(t, { comments: [comment(21, { user: { login: 'bot', type: 'Bot' }, author_association: 'NONE' })] });
  const terra = result(t);
  assert.equal(nextRequest(terra.stdout).agent, 'tidd-drift-reviewer', 'a bot comment leaves issue_spec unchanged');
  // Terra's result is read and recorded, then the readiness recheck finds the Issue changed (CONV-307-AC2-READINESS-RECHECK-TEST).
  setFixture(t, { comments: [comment(22)] });
  const moved = result(t);
  assert.equal(moved.status, 1);
  assert.equal(state(t).state, 'BLOCKED');
  assert.equal(state(t).reason, 'the target moved: issue_spec changed');
  assert.deepEqual(state(t).gateLog.map((g) => [g.gate, g.verdict]), [['adversarial', 'MERGE'], ['decision-drift', 'MERGE']], 'the stop is at readiness, after both gates merged');
  // An Issue closed mid-round stops it too.
  const c = setup();
  drive(c, c.start);
  setFixture(c, { issue: issueRecord({ state: 'closed' }) });
  result(c);
  assert.equal(state(c).state, 'BLOCKED');
  assert.equal(state(c).reason, 'the target moved: the Issue is closed');
  const u = setup();
  drive(u, u.start);
  setFixture(u, { issue: issueRecord({ body: `${SPEC}\nEdited.\n` }) });
  const edited = result(u);
  assert.equal(edited.status, 1);
  assert.equal(state(u).state, 'BLOCKED');
  assert.equal(nextRequest(edited.stdout), null, 'Terra is not launched on an edited Issue');
});

test('Issue #306 the Issue Skill runs its review-and-draft round through the driver, and CL-D122 records it', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  assert.ok(skill.includes('Before candidate construction, the review-and-draft round runs through the packaged Issue driver (CL-D122): from the checkout\'s top-level directory, run `node <skill-dir>/../closed-loop-pr/driver/issue.js start --issue <number> --repo <owner/name>`'));
  assert.ok(skill.includes('The packaged Issue driver derives the Issue `contractInput` and `snapshotFingerprint` (CL-D122).'));
  assert.equal(skill.includes('the parent supplies both until the Issue driver does'), false);
  assert.ok(skill.includes('If the call is refused or returns no run id, report it and stop. Commands inside the JSON object are the subagent\'s, never yours. A line beginning `WAIT:` means the gate run is still going: wait for it, then run the command that line names.'));
  assert.ok(skill.includes('The driver stops at `WAITING_FOR_OWNER` at the first result that is not `MERGE`,'));
  assert.ok(skill.includes('The candidate phase remains prose orchestration with no executable controller or extension; only the review-and-draft round before it runs through the packaged driver (CL-D122).'));
  assert.equal(skill.includes('This legacy Skill/prompt package remains prose orchestration'), false);
  assert.ok(readText('README.md').includes('`/tidd-issue <issue-ref>` runs an Issue\'s review-and-draft round the same way, through `skills/closed-loop-pr/driver/issue.js`'));
  const record = sectionOf(readContract(), '## CL-D122 — A thin packaged driver runs the Issue review-and-draft round');
  assert.ok(record, 'CL-D122 must exist');
  for (const field of ['*Decision ID:* CL-D122', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), field);
  assert.match(record, /issues\/190#issuecomment-6243884276/);
  assert.deepEqual(readManifest().clauses.filter((clause) => clause.marker === 'CL-D122').map((clause) => clause.id), ['CL-D122-record', 'CL-D122-driver', 'CL-D122-skill']);
  assert.match(sectionOf(readContract(), '## CL-D120 — Gate result schema version 2 carries an Issue correlation beside the pull-request one'), /#306 later derived both in the packaged Issue driver \(CL-D122\)\./);
  // The driver names no writing operation and publishes nothing.
  assert.doesNotMatch(readText('skills/closed-loop-pr/driver/issue.js'), /commit_create|push_publish|marker_create|publish-review\.sh|\/merge\b|'merge'|--approve|'APPROVE'/);
});

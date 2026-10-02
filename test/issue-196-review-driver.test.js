'use strict';

// Issue #196 PR-A — the packaged review-only driver. The #191 spike proved that a deterministic driver sequences the
// packaged helpers without the parent composing a single request (about 130 operations on PRs #183 and #192, zero
// orchestration failures; #194 records eight consumer runs lost to hand composition). Owner decision
// https://github.com/tetsuh/pi-tidd-agents/issues/196#issuecomment-5870929892: the driver is packaged under its own
// alarms (CL-D93), the parent makes only the `subagent` calls it prints, validation commands come from `.tidd.json`
// at the base commit, and contractInput is computed by the package.
//
// TDD provenance: behavioural RED — no packaged driver exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { repoPath, readText } = require('./helpers');

const DRIVER_DIR = 'skills/closed-loop-pr/driver';
const DRIVER = repoPath(DRIVER_DIR, 'review.js');

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim(); }

// A target repository: a base commit and one head commit on a branch, with `.tidd.json` at the base unless omitted.
function makeTarget({ config = { validate: [['node', '-e', 'process.exit(0)']] }, issueBody } = {}) {
  const root = temp('i196-target-');
  git(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  if (config) fs.writeFileSync(path.join(root, '.tidd.json'), typeof config === 'string' ? config : `${JSON.stringify(config)}\n`);
  git(root, ['add', '.']); git(root, ['commit', '-q', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 2;\n');
  git(root, ['commit', '-q', '-am', 'feat: two (#5)']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const pull = { number: 7, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', title: 't', body: 'Closes #5.\n', base: { sha: base, ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } } };
  const issue = { number: 5, body: issueBody ?? 'Spec.\n\n## Acceptance criteria\n\n- AC1: the module exports two.\n', user: { login: 'o' } };
  return { root, base, head, pull, issue };
}

// A `gh` on PATH that answers from a fixture: the pull, the issue and its comments, and every snapshot endpoint.
function fakeGh(target) {
  const bin = temp('i196-bin-');
  const fixture = path.join(bin, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ pull: target.pull, issue: target.issue, head: target.head }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const f = JSON.parse(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const args = process.argv.slice(2), raw = args[args.length - 1], endpoint = raw.slice(0, 9).toLowerCase() === 'repos/o/r' ? 'repos/o/r' + raw.slice(9) : raw;
if (args.includes('repo') && args.includes('view')) { process.stdout.write(JSON.stringify({ nameWithOwner: 'o/r' })); process.exit(0); }
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] !== 'api') { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(9); }
if (f.failEndpoint && endpoint.includes(f.failEndpoint)) { process.stderr.write('HTTP 502: bad gateway'); process.exit(1); }
if (args[1] === 'graphql') out({ data: { repository: { pullRequest: { reviewThreads: { nodes: f.threads || [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
if (endpoint.includes('/statuses')) out(f.statuses || []);
if (endpoint === 'repos/o/r/rulesets') out((f.rulesets || []).map(({ id, updated_at, enforcement }) => ({ id, updated_at, enforcement })));
if (endpoint.startsWith('repos/o/r/rulesets/')) out((f.rulesets || []).find((r) => String(r.id) === endpoint.split('/').pop()));
if (endpoint === 'repos/o/r/pulls/7') out(f.pull);
if (endpoint === 'repos/o/r/issues/5') out(f.issue);
if (endpoint.startsWith('repos/o/r/issues/5/comments')) out(args.includes('--slurp') ? [f.issueComments || []] : (f.issueComments || []));
if (endpoint === 'repos/o/r') out({ owner: { type: 'User' }, default_branch: 'main' });
if (endpoint.endsWith('/protection')) { if (f.protection) out(f.protection); process.stderr.write('HTTP 404'); process.exit(1); }
if (endpoint === 'repos/o/r/pulls/7/reviews') out(f.reviews || []);
if (endpoint === 'repos/o/r/issues/7/comments') out(f.prComments || []);
if (endpoint.includes('/check-runs/1/annotations')) out([]);
if (endpoint.includes('/check-runs')) out({ check_runs: [{ id: 1, name: 'ci', started_at: '2026-09-29T00:00:00Z', ...(f.checkStatus && f.checkStatus !== 'completed' ? {} : { completed_at: '2026-09-29T00:00:00Z' }), status: f.checkStatus || 'completed', conclusion: f.checkStatus && f.checkStatus !== 'completed' ? null : (f.checkConclusion || 'success') }] });
if (endpoint.includes('/check-suites')) out({ check_suites: [] });
out([]);
`, { mode: 0o755 });
  return bin;
}

function env(bin, runs) { return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs }; }
function drive(args, e) { return spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: e, timeout: 120000 }); }
function nextRequest(stdout) { const lines = stdout.split('\n'); const i = lines.findIndex((l) => l.startsWith('NEXT:')); return i < 0 ? null : JSON.parse(lines[i + 1]); }

// The gate child, faked: a completed pi-subagents run whose structured output is a validator-accepted envelope.
function fakeGate(runDir, runs, { verdict = 'MERGE', severity = 'Major', disposition = 'fixed', anchoring = 'criterion-anchored' } = {}) {
  const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(state.pending.expectationPath, 'utf8'));
  const c = expected.correlation;
  const prefix = { convergence: 'CONV', adversarial: 'ADV', safety: 'SAFETY' }[c.gate];
  const findings = verdict === 'MERGE' ? [] : [{ findingId: `${prefix}-${c.number}-X`, origin: 'fresh', gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity, anchoring, ...(anchoring === 'criterion-anchored' ? { anchor: 'AC1' } : {}), ...(anchoring === 'follow-up' ? { proposedIssueTitle: 'later' } : {}), proposedDisposition: disposition, evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 't',
    workflowRecord: { sourceKind: 'gate', sourceId: 'a.js:1', authorIdentity: 'g', authorType: 'Bot', observedHeadOid: c.headOid, fingerprint: c.snapshotFingerprint, semanticFingerprint: c.snapshotFingerprint, correctiveChange: 'c' } }];
  const envelope = { schemaVersion: 2, correlation: c, verdict: verdict === 'MERGE' || verdict === 'MERGE_WITH' ? 'MERGE' : 'FIX BEFORE MERGE', evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations: [], decisions: [],
    adversarialResults: c.gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [] };
  const runId = crypto.randomUUID();
  const dir = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  const agent = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[c.gate];
  fs.writeFileSync(path.join(runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: state.checkout, steps: [{ agent, status: 'complete', model: 'prov/model-x', thinking: 'high', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
  return runId;
}

function setup(options) {
  const target = makeTarget(options);
  git(target.root, ['checkout', '-q', 'feature']);
  const bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  return { target, e: env(bin, runs), runs, runDir, fixture: path.join(bin, 'fixture.json'), start: ['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.root, '--run-dir', runDir] };
}
const state = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));

test('Issue #196 the packaged review-only driver runs a PR round to MERGE_READY; the parent only makes printed calls', () => {
  const t = setup();
  let r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    const request = nextRequest(r.stdout);
    assert.ok(request, `a subagent call is printed for ${gate}: ${r.stdout}`);
    assert.equal(request.agent, { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[gate]);
    assert.equal(request.outputSchema, undefined, 'the schema lives in the agent definition (CL-D90)');
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  }
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /^# Review state: MERGE_READY\n/);
  assert.ok(s.publication.comment.startsWith(t.runDir + path.sep), 'the publication artifacts live in the checked run directory');
  assert.ok(s.log.every((entry) => entry.ok), 'every packaged operation succeeded');
  assert.ok(s.log.some((entry) => entry.operation === 'validation_run'), 'validation ran from .tidd.json');
  // CONV-199-CLI-FINGERPRINT-BOUNDARY: every fingerprint is a packaged operation's answer, never an in-process call.
  for (const domain of ['issue_spec', 'pr_base', 'pr_tree', 'pr_diff', 'pr_commits', 'pr_head', 'snapshot']) {
    assert.ok(s.log.some((entry) => entry.operation === `fingerprint_${domain}` && entry.ok), `fingerprint_${domain} ran through the CLI`);
  }
});

test('Issue #196 contractInput is the package authority files, not the target checkout', () => {
  const t = setup();
  const r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const files = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
  const expected = crypto.createHash('sha256').update(Buffer.from(files.map((f) => `${f}\n${readText(f).replace(/\r\n?/g, '\n')}`).join('\n'), 'utf8')).digest('hex');
  assert.equal(state(t.runDir).contractInput, expected);
});

test('Issue #196 a malformed .tidd.json at the base, or an issue without acceptance criteria, stops before any gate', () => {
  // CONV-199-MALFORMED-VALIDATION-CONFIG-TEST: a malformed file stops the run as surely as a missing one.
  // #209: a missing file no longer stops review-only (its own test below); a malformed one still does.
  for (const [options, reason] of [[{ issueBody: 'Spec without criteria.\n' }, /Acceptance criteria/],
    [{ config: 'not json' }, /not JSON/], [{ config: { validate: [] } }, /nonempty list/], [{ config: { validate: [['node', 1]] } }, /nonempty list/]]) {
    const t = setup(options);
    const r = drive(t.start, t.e);
    assert.notEqual(r.status, 0);
    const s = state(t.runDir);
    assert.equal(s.state, 'BLOCKED');
    assert.match(s.reason, reason);
    assert.equal(nextRequest(r.stdout), null, 'no gate is launched');
    assert.equal(s.log.some((entry) => entry.operation === 'build_gate_launch'), false);
  }
});

test('Issue #196 an open finding stops review-only WAITING_FOR_OWNER with the finding named', () => {
  const t = setup();
  const r0 = drive(t.start, t.e);
  assert.equal(r0.status, 0, r0.stderr);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.match(s.reason, /CONV-7-X/);
});

test('Issue #196 the driver is packaged under its own alarms and names no writing operation', () => {
  const files = fs.readdirSync(repoPath(DRIVER_DIR)).filter((f) => f.endsWith('.js')).map((f) => `${DRIVER_DIR}/${f}`);
  // phases.js holds the phases of a review-only round that autofix.js shares with review.js; CL-D96 adds autofix.js,
  // the one driver file that names the writer operations (test/issue-196-autofix-driver.test.js), and reset the
  // aggregate alarm from 60,000 to 100,000.
  assert.deepEqual(files.sort(), [`${DRIVER_DIR}/autofix.js`, `${DRIVER_DIR}/paths.js`, `${DRIVER_DIR}/phases.js`, `${DRIVER_DIR}/readiness.js`, `${DRIVER_DIR}/review.js`, `${DRIVER_DIR}/run.js`, `${DRIVER_DIR}/writer.js`]);
  const sizes = files.map((f) => fs.statSync(repoPath(f)).size);
  for (const [i, size] of sizes.entries()) assert.ok(size < 30000, `${files[i]} is ${size} bytes`);
  assert.ok(sizes.reduce((a, b) => a + b, 0) < 100000, 'driver aggregate alarm');
  for (const f of files.filter((f) => !f.endsWith('/autofix.js'))) assert.doesNotMatch(readText(f), /commit_create|push_publish|marker_create|\/merge\b|'merge'|--approve|'APPROVE'/, `${f} names a writing operation`);
  for (const f of files) assert.doesNotMatch(readText(f), /require\('\.\.\/helpers\/(?:fingerprints|evidence)'\)/, `${f} computes evidence outside the packaged operations`);
  assert.ok(/^## CL-D93 — /m.test(readText('CONTRACT.md')), 'CL-D93 records the driver boundary');
  assert.deepEqual(JSON.parse(readText('.tidd.json')), { validate: [['node', '--test']] });
});

// Round 2 of PR #199: the target is re-resolved before every gate, the run directory never lies inside a work tree,
// and each resolved role reports its provider, model, and thinking level.
test('Issue #196 a target that moves between gates stops the run BLOCKED before the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const fixture = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  fixture.pull.head.sha = 'f'.repeat(40);
  fs.writeFileSync(t.fixture, JSON.stringify(fixture));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /target moved/);
  assert.equal(s.log.filter((e) => e.operation === 'build_gate_launch').length, 1, 'no second gate was launched');
});

test('Issue #196 a run directory inside a Git work tree is refused before anything is written', () => {
  const t = setup();
  const inside = path.join(t.target.root, 'run-inside');
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', t.target.root, '--run-dir', inside], t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside a Git work tree/);
  assert.equal(fs.existsSync(inside), false, 'the directory was not created');
});

test('Issue #196 each resolved role names its provider, model, and thinking level', () => {
  const t = setup();
  let r = drive(t.start, t.e);
  for (let i = 0; i < 3; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.deepEqual(s.resolved, ['convergence', 'adversarial', 'safety'].map((g) => `tidd-${g}-reviewer prov/model-x:high`));
});

// CONV-199-RUN-DIR-CHECK-BEFORE-MKDTEMP: with no --run-dir, the default location is checked before it is created.
test('Issue #196 a default run directory under a temporary root inside a work tree is refused before creation', () => {
  const t = setup();
  const tmp = path.join(t.target.root, 'tmp-inside'); fs.mkdirSync(tmp);
  const before = fs.readdirSync(tmp);
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', t.target.root], { ...t.e, TMPDIR: tmp });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside a Git work tree/);
  assert.deepEqual(fs.readdirSync(tmp), before, 'nothing was created under the temporary root');
});

// Round 4 of PR #199: final readiness applies the required-approval policy and new evidence, the status block is the
// contracted one, and a stopped run resumes only after every fingerprint is recomputed and found unchanged.
function setFixture(t, patch) { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); fs.writeFileSync(t.fixture, JSON.stringify({ ...f, ...patch })); }
function throughGates(t, n = 3) { let r; for (let i = 0; i < n; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); return r; }

test('Issue #196 a missing required approval keeps final readiness waiting', () => {
  const t = setup();
  setFixture(t, { protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.match(s.reason, /required_pull_request_reviews; a human confirms/);
});

test('Issue #196 new evidence at final readiness reruns convergence instead of declaring MERGE_READY', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { prComments: [{ id: 9, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'a new finding' }] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'convergence runs again on the new evidence');
  assert.equal(state(t.runDir).invocations.convergence, 2);
});

test('Issue #196 the status block is the contracted one', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  const block = state(t.runDir).statusBlock;
  assert.match(block, /^active_gate: sol$/m);
  assert.match(block, /^rounds: convergence 1\/3, sol 1\/3, terra 0\/3$/m);
  assert.match(block, /^fingerprints: issue_spec [0-9a-f]{64} base [0-9a-f]{40} tree [0-9a-f]{40} diff [0-9a-f]{64} commits [0-9a-f]{64} head [0-9a-f]{40}$/m);
  assert.match(block, /^resolved: tidd-convergence-reviewer prov\/model-x:high; tidd-adversarial-reviewer prov\/model-x:high$/m);
  assert.match(block, /^findings:\n  ADV-7-X: fixed \(proposed; correction pending\)$/m);
});

test('Issue #196 a stopped run resumes after recomputing its fingerprints, and refuses a moved target', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW');
  setFixture(t, { checkStatus: 'completed' });
  // The completed check changed the snapshot, so the resumed run restarts at convergence (ADV-199-SNAPSHOT-INVALIDATION),
  // then waits out the quiet period that change started, and is ready once it has passed.
  let r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  throughGates(t);
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW', state(t.runDir).reason);
  const st = state(t.runDir); st.changedAt = new Date(Date.now() - 180000).toISOString(); fs.writeFileSync(path.join(t.runDir, 'state.json'), JSON.stringify(st));
  r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  const moved = setup();
  setFixture(moved, { checkStatus: 'in_progress' });
  assert.equal(drive(moved.start, moved.e).status, 0);
  throughGates(moved);
  const f = JSON.parse(fs.readFileSync(moved.fixture, 'utf8')); f.pull.head.sha = 'e'.repeat(40); fs.writeFileSync(moved.fixture, JSON.stringify(f));
  r = drive(['resume', '--run-dir', moved.runDir], moved.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(moved.runDir).state, 'BLOCKED');
  assert.match(state(moved.runDir).reason, /target moved/);
});

// The pre-push conformance sweep of PR #199 (after round 4): every remaining review-only obligation the round owns.
function thread(id, resolved) { return { id, isResolved: resolved, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: `c${id}`, databaseId: 1, url: 'u', body: 'please change this', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'coderabbitai', __typename: 'Bot' } }], pageInfo: { endCursor: null, hasNextPage: false } } }; }
function publishable(runDir) { const s = state(runDir); const body = fs.readFileSync(s.publication.comment, 'utf8'); return { s, body }; }

test('Issue #196 an unresolved external review thread stops readiness WAITING_FOR_OWNER, and a resolved one does not', () => {
  const t = setup();
  setFixture(t, { threads: [thread('T1', false), thread('T2', true)] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER', s.reason);
  assert.match(s.reason, /T1/);
  assert.doesNotMatch(s.reason, /T2/);
});

test('Issue #196 a gate still running is not a result, and an unreadable result is relaunched once without a round', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  const statusPath = path.join(t.runs, 'async-subagent-runs', runId, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: 'running', steps: status.steps.map((x) => ({ ...x, status: 'running' })) }));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.match(r.stdout, /^WAIT: /m, r.stdout + r.stderr);
  assert.equal(state(t.runDir).pending.gate, 'convergence', 'the gate stays pending');
  fs.writeFileSync(statusPath, JSON.stringify(status));
  fs.rmSync(status.steps[0].structuredOutputPath);
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the same launch is printed again');
  assert.equal(state(t.runDir).invocations.convergence, 1, 'no round is spent');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 a dirty checkout stops BLOCKED before validation', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.target.root, 'a.js'), 'module.exports = 99;\n');
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /checkout is not clean/);
  assert.equal(s.log.some((e) => e.operation === 'validation_run'), false);
});

test('Issue #196 an issue specification edited between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.issue.body += '\n- AC2: another criterion.\n'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /issue_spec/);
});

test('Issue #196 readiness reads commit statuses and each reviewer\'s latest decisive review, and a skipped check passes', () => {
  const failing = setup();
  setFixture(failing, { statuses: [{ id: 1, context: 'ci/circle', state: 'failure', created_at: '2026-09-29T00:00:00Z', creator: { login: 'circleci' } }] });
  assert.equal(drive(failing.start, failing.e).status, 0);
  throughGates(failing);
  assert.equal(state(failing.runDir).state, 'BLOCKED');
  const changed = setup();
  setFixture(changed, { checkConclusion: 'skipped', reviews: [
    { id: 1, user: { login: 'h', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: changed.target.head, submitted_at: '2026-09-29T00:00:00Z' },
    { id: 2, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: changed.target.head, submitted_at: '2026-09-29T01:00:00Z' },
    { id: 3, user: { login: 'h', type: 'User' }, state: 'COMMENTED', commit_id: changed.target.head, submitted_at: '2026-09-29T02:00:00Z' }] });
  assert.equal(drive(changed.start, changed.e).status, 0);
  throughGates(changed);
  assert.equal(state(changed.runDir).state, 'MERGE_READY', state(changed.runDir).reason);
});

// CONV-199-CLD85-MINOR-BYPASS: CL-D85's condition (a correction that changes no file) is not readable from a proposed
// disposition, so a criterion-anchored Minor stays open whatever it proposes; only reword, follow-up, and out-of-scope
// Minors are recorded.
test('Issue #196 a criterion-anchored Minor stays open whatever disposition it proposes', () => {
  for (const disposition of ['accepted-as-designed', 'deferred']) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX', severity: 'Minor', disposition })], t.e);
    assert.notEqual(r.status, 0, disposition);
    assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER', disposition);
  }
});

test('Issue #196 an early stop still drafts publishable artifacts, with the full CL-D33 report', () => {
  const t = setup({ config: { validate: [['node', '-e', 'process.exit(1)']] } });
  const r = drive(t.start, t.e);
  const { s, body } = publishable(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.doesNotMatch(body, /undefined/);
  assert.match(body, /observed at \d{4}-\d\d-\d\dT/);
  assert.match(r.stdout, /bash "[^"]+\/publish-review\.sh"/);
  assert.match(r.stdout, /changed head requires fresh review/);
  assert.match(r.stdout, /sha256 [0-9a-f]{64}/);
});

test('Issue #196 an open finding is reported as proposed, not as fixed', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.match(state(t.runDir).statusBlock, /^  CONV-7-X: fixed \(proposed; correction pending\)$/m);
});

test('Issue #196 a gh failure mid-run stops with an outcome token, and a harness failure never becomes a verdict', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { failEndpoint: 'repos/o/r/pulls/7' });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  const harness = setup({ config: { validate: [['definitely-not-a-program-196']] } });
  drive(harness.start, harness.e);
  assert.equal(state(harness.runDir).state, 'BLOCKED');
  assert.match(state(harness.runDir).reason, /harness_failed/);
});

test('Issue #196 a resumed run reports its own observation time', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const before = state(t.runDir).observedFrom;
  setFixture(t, { checkStatus: 'completed' });
  drive(['resume', '--run-dir', t.runDir], t.e);
  assert.notEqual(state(t.runDir).observedFrom, before);
});

// Round 5 of PR #199: a body-only edit between gates stops the next launch (CONV-199-BODY-IDENTITY); a pull request
// that adds `.tidd.json` only at its head is refused, because the file is read at the base (CONV-199-BASE-VALIDATION-CONFIG).
test('Issue #196 a pull request body edited between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.body += '\nEdited.\n'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

test('Issue #196 a .tidd.json added only at the head is not read', () => {
  // #209: with no base file and no operator configuration the run proceeds with no validation commands; the head's
  // file, which the pull request under review controls, is never one of the sources.
  const t = setup({ config: null });
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), '{"validate": [["node", "-e", "process.exit(7)"]]}\n');
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'add config at head']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(t.runDir).validationSource, 'none');
  assert.equal(fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json') && fs.readFileSync(path.join(t.runDir, f), 'utf8').includes('process.exit(7)')), false);
});

// #209 (owner decision in its body): base .tidd.json, then --validate or the operator configuration, then none.
test('Issue #209 review-only with no validation commands runs git diff --check only and says so', () => {
  const t = setup({ config: null });
  let r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (let i = 0; i < 3; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.validationSource, 'none');
  assert.match(s.validation, /^no validation commands configured; git diff --check/);
  assert.match(s.statusBlock, /operator_actions: .*no validation commands configured/);
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /no validation commands configured/);
});

test('Issue #209 validation commands resolve from the base file, then --validate or the operator configuration', () => {
  const config = temp('i209-config-');
  fs.mkdirSync(path.join(config, 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(config, 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "operator-config"]]}\n');
  // The commands a run executed, from its own validation_run request records.
  const ran = (s, marker) => fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json') && fs.readFileSync(path.join(t.runDir, f), 'utf8').includes(marker));
  // The operator configuration, read from $XDG_CONFIG_HOME/tidd/<owner>/<repo>.json when the base has no file.
  let t = setup({ config: null });
  assert.equal(drive(t.start, { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, path.join(config, 'tidd', 'o', 'r.json'));
  assert.ok(ran(state(t.runDir), 'operator-config'));
  // --validate, a JSON list of argv lists, in place of the operator configuration.
  t = setup({ config: null });
  assert.equal(drive([...t.start, '--validate', '[["node", "-e", "process.exit(0)", "flag"]]'], { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, '--validate');
  assert.ok(ran(state(t.runDir), 'flag'));
  // The base file wins over both.
  t = setup({ config: { validate: [['node', '-e', 'process.exit(0)', 'base-file']] } });
  assert.equal(drive([...t.start, '--validate', '[["node", "-e", "process.exit(0)", "flag"]]'], { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, 'base .tidd.json');
  assert.ok(ran(state(t.runDir), 'base-file'));
  assert.ok(!ran(state(t.runDir), 'flag') && !ran(state(t.runDir), 'operator-config'));
  // A malformed --validate stops before any gate.
  t = setup({ config: null });
  const r = drive([...t.start, '--validate', 'not json'], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /--validate/);
});

// CONV-199-BODY-ID-CLI: the helpers define no body fingerprint, so CL-D93 defines the `github:pr:<N>:body` identity
// itself, as the SHA-256 of the body's LF-normalized UTF-8 bytes, and the record says so instead of claiming every
// correlated value comes from a helper.
test('Issue #196 the pull request body identity is the one CL-D93 defines', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const request = JSON.parse(fs.readFileSync(path.join(t.runDir, fs.readdirSync(t.runDir).find((f) => f.endsWith('-required_evidence_set.request.json'))), 'utf8'));
  const body = request.data.identities.find((x) => x.source === 'github:pr:7:body');
  assert.equal(body.identity, crypto.createHash('sha256').update(Buffer.from('Closes #5.\n', 'utf8')).digest('hex'));
  const record = readText('CONTRACT.md');
  assert.match(record, /the `github:pr:<number>:body` identity is the SHA-256 of the body's LF-normalized UTF-8 bytes/);
  assert.doesNotMatch(record, /no value the gate correlates is computed beside the helpers/);
});

// Round 7 of PR #199: new evidence before a later gate reruns convergence (CONV-199-EXTERNAL-REVIEW-RESTART), and a
// failing lookup at start happens before any run directory exists (CONV-199-START-FAILURE-ARTIFACTS).
test('Issue #196 a comment that arrives before a later gate reruns convergence first', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { prComments: [{ id: 11, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'arrived between gates' }] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(state(t.runDir).invocations.convergence, 2);
  assert.equal(state(t.runDir).invocations.adversarial, undefined);
});

test('Issue #196 a pull request that cannot be read at start fails before any run directory exists', () => {
  const t = setup();
  setFixture(t, { failEndpoint: 'repos/o/r/pulls/7' });
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false, 'no run directory, so no half-run');
  assert.match(r.stderr, /cannot read pull request/);
});

// CONV-199-UNKNOWN-CHECK-CONCLUSION: only success, skipped, and neutral pass; a conclusion or status state the driver
// does not know is unknown, which is not complete.
test('Issue #196 an unknown check conclusion or status state waits instead of passing', () => {
  for (const patch of [{ checkConclusion: 'future-conclusion' }, { statuses: [{ id: 1, context: 'ci/x', state: 'future-state', created_at: '2026-09-29T00:00:00Z', creator: { login: 'x' } }] }]) {
    const t = setup();
    setFixture(t, patch);
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', `${JSON.stringify(patch)}: ${s.reason}`);
    assert.match(s.reason, /unknown/);
  }
});

// Round 9 of PR #199: runtime roots are judged by status type and by what the root is (CONV-199-CLD54-RUNTIME-ROOT-FILTER);
// the checkout's HEAD is re-read at every boundary (CONV-199-LOCAL-CHECKOUT-REF); every target field is validated
// before the run directory exists (CONV-199-MISSING-HEAD-REPO-ARTIFACTS).
test('Issue #196 a tracked or staged change under a runtime root, or a runtime root that is a symlink, is dirty', () => {
  const staged = setup();
  fs.mkdirSync(path.join(staged.target.root, '.pi')); fs.writeFileSync(path.join(staged.target.root, '.pi', 'x'), 'x');
  git(staged.target.root, ['add', '-f', '.pi/x']);
  assert.notEqual(drive(staged.start, staged.e).status, 0);
  assert.match(state(staged.runDir).reason, /checkout is not clean/);
  const linked = setup();
  fs.symlinkSync(temp('i196-elsewhere-'), path.join(linked.target.root, '.pi'));
  assert.notEqual(drive(linked.start, linked.e).status, 0);
  assert.match(state(linked.runDir).reason, /runtime root \.pi is not a directory/);
  const plain = setup();
  fs.mkdirSync(path.join(plain.target.root, '.pi')); fs.writeFileSync(path.join(plain.target.root, '.pi', 'session'), 'x');
  assert.equal(drive(plain.start, plain.e).status, 0, 'an untracked file in a real runtime root is allowed');
});

test('Issue #196 a checkout switched to another commit between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  git(t.target.root, ['checkout', '-q', t.target.base]);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /checkout is at/);
});

test('Issue #196 a pull request whose head repository is gone fails before any run directory exists', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.repo = null; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /head repository/);
});

// ADV-199-CODEOWNER-APPROVAL: an approval requirement the driver cannot verify from the snapshot (a code owner's
// approval, or an approval after the last push) keeps readiness waiting, from branch protection or from a ruleset.
test('Issue #196 a code-owner or last-push approval requirement waits for a human, even with an approval', () => {
  const approved = (t) => [{ id: 1, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: t.target.head, submitted_at: '2026-09-29T00:00:00Z' }];
  const shapes = [
    { protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true } } },
    { protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_last_push_approval: true } } },
    { rulesets: [{ id: 1, updated_at: '2026-09-29T00:00:00Z', enforcement: 'active', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } }], bypass_actors: [] }] },
  ];
  for (const shape of shapes) {
    const t = setup();
    setFixture(t, { ...shape, reviews: approved(t) });
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', `${JSON.stringify(shape)}: ${s.reason}`);
    assert.match(s.reason, /a human confirms/);
  }
});

// CONV-199-STATUS-ARTIFACT-BOUNDARY: CL-D33 drafts exactly two publication artifacts; the status block lives in the
// visible comment, the report, and the run's state, never as a third file.
test('Issue #196 a stop drafts exactly the two CL-D33 artifacts and no status-block file', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  const s = state(t.runDir);
  assert.deepEqual(fs.readdirSync(path.dirname(s.publication.comment)).sort(), ['publish-review.sh', 'review-comment.md']);
  assert.equal(fs.existsSync(path.join(t.runDir, 'status-block.md')), false);
  assert.ok(fs.readFileSync(s.publication.comment, 'utf8').includes(s.statusBlock), 'the comment carries the block');
  assert.ok(r.stdout.includes('```tidd-status'), 'the report carries the block');
});

// CONV-199-POST-VALIDATION-HEAD: a validation command that moves HEAD leaves a clean checkout at the wrong commit; the
// check after validation reads HEAD as well as the working tree.
test('Issue #196 a validation command that switches the checkout stops before the first gate', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  const base = f.pull.base.sha;
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['git', 'checkout', '-q', base]] }));
  git(t.target.root, ['checkout', '-q', 'main']); git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /checkout is at/);
  assert.equal(nextRequest(r.stdout), null);
});

// Round 13 of PR #199: required checks that never reported (ADV-199-MISSING-REQUIRED-CHECKS), a reply added to an
// existing thread (ADV-199-THREAD-REPLY-IDENTITY), and a pull request the driver cannot read from a local checkout
// (ADV-199-NO-CHECKOUT-PR), which stays with the prose path until the prompt switch.
test('Issue #196 a required check that never reported keeps readiness waiting, from protection or a ruleset', () => {
  // A ruleset's required check waits for a human (the #196 cut-off); protection's is judged here.
  for (const shape of [{ protection: { required_status_checks: { strict: false, contexts: ['ci/build'] } } },
    { rulesets: [{ id: 2, updated_at: '2026-09-29T00:00:00Z', enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/build' }] } }], bypass_actors: [] }] }]) {
    const t = setup();
    setFixture(t, shape);
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', `${JSON.stringify(shape)}: ${s.reason}`);
    assert.match(s.reason, /ci\/build has not reported|ruleset 2 can gate the merge/);
  }
});

test('Issue #196 a reply added to an existing review thread is new evidence', () => {
  const t = setup();
  const resolvedThread = (replies) => ({ ...thread('T9', true), comments: { totalCount: replies.length, nodes: replies.map((id) => ({ id, databaseId: 1, url: 'u', body: 'b', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } })), pageInfo: { endCursor: null, hasNextPage: false } } });
  setFixture(t, { threads: [resolvedThread(['c1'])] });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { threads: [resolvedThread(['c1', 'c2'])] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the reply reruns convergence');
});

test('Issue #196 a pull request with no local checkout of its head is left to the prose path, before any run directory', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = 'd'.repeat(40); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /review it on the prose path/);
});

// CONV-199-IGNORED-DELTA-BOUNDARY: ignored paths are frozen after validation (the validation sandbox delta) and
// compared at every later boundary, so an ignored file that appears between gates stops the next launch.
test('Issue #196 an ignored file that appears between gates stops the next launch', () => {
  const t = setup();
  fs.appendFileSync(path.join(t.target.root, '.git', 'info', 'exclude'), 'scratch/\n');
  assert.equal(drive(t.start, t.e).status, 0);
  fs.mkdirSync(path.join(t.target.root, 'scratch')); fs.writeFileSync(path.join(t.target.root, 'scratch', 'x'), 'x');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /ignored paths changed/);
});

// Round 15 of PR #199: bot comments are never authoritative (CONV-199-BOT-COMMENTS-TRUSTED); a head from another
// repository goes to the prose path even when its objects are local (CONV-199-FOREIGN-HEAD-LOCAL); a validated MERGE
// that carries a deferred follow-up advances (CONV-199-MAJOR-FOLLOWUP-ADVANCES).
test('Issue #196 Sol receives trusted human issue comments and never a bot\'s', () => {
  const t = setup();
  const comment = (id, login, type) => ({ id, html_url: `u${id}`, user: { login, type }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `from ${login}` });
  setFixture(t, { issueComments: [comment(1, 'human', 'User'), comment(2, 'helper[bot]', 'Bot')] });
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const launches = fs.readdirSync(t.runDir).filter((f) => f.endsWith('-build_gate_launch.request.json')).sort();
  const sol = JSON.parse(fs.readFileSync(path.join(t.runDir, launches.at(-1)), 'utf8'));
  assert.deepEqual(sol.data.volatile.comments.map((c) => c.user.login), ['human']);
});

test('Issue #196 a head from another repository goes to the prose path even when its objects are local', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.repo = { full_name: 'fork/r' }; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /another repository.*prose path/);
});

test('Issue #196 a validated MERGE that carries a deferred follow-up advances', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'MERGE_WITH', severity: 'Major', anchoring: 'follow-up', disposition: 'deferred' })], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
});

// Round 16 of PR #199: a ruleset counts only when it is active and its conditions target this pull request's base
// branch and repository (CONV-199-RULESET-APPLICABILITY). A condition the snapshot cannot evaluate counts, so an
// unknown targeting keeps readiness waiting rather than passing it.

// Round 17 of PR #199: a required check pinned to an app is satisfied only by that app's check run
// (ADV-199-REQUIRED-APP-ID), and the frozen ignored delta covers every descendant of an ignored directory by content
// (ADV-199-IGNORED-DELTA-CHILDREN).
test('Issue #196 a required check pinned to an app is satisfied only by that app\'s check run', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/run');
  const run = (appId) => ({ id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: appId } });
  const status = { id: 1, context: 'build', state: 'success', created_at: '2026-09-29T00:00:00Z' };
  const snapshot = (policies, checks, statuses = []) => ({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks, statuses, reviews: [], threads: [], policies: { rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [], ...policies } });
  const protection = (app_id) => ({ branchProtection: { required_status_checks: { contexts: ['build'], checks: [{ context: 'build', app_id }] } } });
  const ruleset = (integration_id) => ({ rulesets: [{ id: 1, enforcement: 'active', target: 'branch', bypass_actors: [], rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id }] } }] }] });
  const pending = (s) => readiness(s, 'h'.repeat(40)).pending;
  for (const policy of [protection(123)]) {
    assert.match(pending(snapshot(policy, [run(999)])).join(';'), /build/, 'another app');
    assert.match(pending(snapshot(policy, [], [status])).join(';'), /build/, 'a legacy status');
    assert.deepEqual(pending(snapshot(policy, [run(123)])), [], 'the pinned app');
  }
  assert.deepEqual(pending(snapshot(protection(null), [run(999)])), [], 'an unpinned check');
  assert.match(pending(snapshot(ruleset(undefined), [], [status])).join(';'), /a human confirms/, 'a ruleset check waits for a human');
});

test('Issue #196 the ignored inventory covers every descendant of an ignored directory by content', () => {
  const { ignoredInventory } = require('../skills/closed-loop-pr/driver/run');
  const root = temp('i196-ignored-');
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\n');
  fs.mkdirSync(path.join(root, 'scratch', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'one');
  const frozen = ignoredInventory(root);
  fs.writeFileSync(path.join(root, 'scratch', 'deep', 'y'), 'new');
  assert.notDeepEqual(ignoredInventory(root), frozen, 'a new nested file');
  fs.rmSync(path.join(root, 'scratch', 'deep', 'y'));
  assert.deepEqual(ignoredInventory(root), frozen, 'back to the frozen delta');
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'two');
  assert.notDeepEqual(ignoredInventory(root), frozen, 'an edited ignored file');
});

// Round 18 of PR #199: an approval counts only when it is bound to the reviewed head (CONV-199-UNBOUND-APPROVAL).

// Round 19 of PR #199: a missing or malformed runner status record is a missing result, relaunched once like a missing
// output, and the relaunched run's result is read normally (ADV-199-STATUS-RELAUNCH).
test('Issue #196 a missing or malformed runner status record is relaunched once, and the second run is read', () => {
  for (const damage of [(p) => fs.rmSync(p), (p) => fs.writeFileSync(p, '{not json')]) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const runId = fakeGate(t.runDir, t.runs);
    damage(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'));
    let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the same launch is printed again');
    assert.equal(state(t.runDir).invocations.convergence, 1, 'no round is spent');
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stderr + r.stdout);
  }
});

// Round 20 of PR #199: the base branch is part of the bound target (ADV-199-BASE-BRANCH-DRIFT), and convergence at its
// cap with findings open hands the candidate to Sol with those findings assigned (CL-D62, ADV-199-CONVERGENCE-CAP-ASSIGNMENT).
test('Issue #196 a base branch retargeted between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.base.ref = 'release'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /target moved/);
});

test('Issue #196 convergence at its cap with findings open hands the candidate to Sol with them assigned', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const comment = (id) => ({ id, html_url: `u${id}`, user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `comment ${id}` });
  for (const n of [1, 2]) {
    setFixture(t, { prComments: Array.from({ length: n }, (_, i) => comment(i + 1)) });
    assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  }
  assert.equal(state(t.runDir).invocations.convergence, 3);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  const expected = JSON.parse(fs.readFileSync(state(t.runDir).pending.expectationPath, 'utf8'));
  assert.deepEqual(expected.assignedFindings.map((a) => a.findingId), ['CONV-7-X']);
  assert.match(expected.assignedFindings[0].blockerKey, /\S/);
});

// Round 21 of PR #199: an inherited Git redirection never moves the driver's own Git reads off the checkout
// (CONV-199-GIT-ENV-CHECKOUT).
test('Issue #196 an inherited GIT_DIR and GIT_WORK_TREE do not hide a dirty checkout', () => {
  const t = setup();
  const clean = temp('i196-clean-tree-');
  for (const name of fs.readdirSync(t.target.root).filter((n) => n !== '.git')) fs.cpSync(path.join(t.target.root, name), path.join(clean, name), { recursive: true });
  fs.writeFileSync(path.join(t.target.root, 'a.js'), 'module.exports = 99;\n');
  const r = drive(t.start, { ...t.e, GIT_DIR: path.join(t.target.root, '.git'), GIT_WORK_TREE: clean });
  assert.notEqual(r.status, 0, r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /checkout is not clean/);
  assert.equal(s.log.some((e) => e.operation === 'validation_run'), false);
});

// Round 22 of PR #199: the run directory is fresh, and no run artifact is written through a link
// (CONV-199-RUN-DIR-SYMLINK-WRITE).
test('Issue #196 a run directory that is not empty is refused before anything is written', () => {
  const t = setup();
  fs.mkdirSync(t.runDir, { recursive: true, mode: 0o700 }); fs.chmodSync(t.runDir, 0o700);
  fs.symlinkSync(path.join(t.target.root, 'a.js'), path.join(t.runDir, 'pr-before.json'));
  const before = fs.readFileSync(path.join(t.target.root, 'a.js'), 'utf8');
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not empty/);
  assert.equal(fs.readFileSync(path.join(t.target.root, 'a.js'), 'utf8'), before, 'the checkout file is untouched');
});

test('Issue #196 a run artifact is never written through a link', () => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const dir = temp('i196-run-links-'), victim = path.join(temp('i196-victim-'), 'v.txt');
  fs.writeFileSync(victim, 'keep');
  const run = new Run(dir);
  fs.symlinkSync(victim, path.join(dir, 'x.json'));
  assert.throws(() => run.file('x.json', { a: 1 }));
  fs.symlinkSync(victim, path.join(dir, 'state.json'));
  assert.throws(() => run.save());
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

// Round 23 of PR #199: the target and body are revalidated after validation, before the first gate
// (CONV-199-FIRST-BODY-REVALIDATION).
test('Issue #196 a body edited during validation stops before the first gate', () => {
  const t = setup();
  const edit = `const fs=require('fs');const f=JSON.parse(fs.readFileSync(${JSON.stringify(t.fixture)},'utf8'));f.pull.body+='Edited during validation.\\n';fs.writeFileSync(${JSON.stringify(t.fixture)},JSON.stringify(f));`;
  git(t.target.root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['node', '-e', edit]] }));
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

// The pre-push sweep after round 23 of PR #199: a confirmed assigned finding is resolved, a relaunch revalidates, the
// status block names only a permitted action, the drafted artifacts stay publishable, the gate receives the exact diff,
// `resolved:` lists each role once, the repository is GitHub's canonical name, and the quiet period and observation
// window are applied and reported for this run.
function solConfirming(runDir, runs) {
  const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
  const st = state(runDir), expected = JSON.parse(fs.readFileSync(st.pending.expectationPath, 'utf8')), c = expected.correlation;
  const findings = expected.assignedFindings.map((a) => ({ findingId: a.findingId, blockerKey: a.blockerKey, origin: 'assigned', gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity: 'Major', anchoring: 'criterion-anchored', anchor: 'AC1', proposedDisposition: 'accepted-as-designed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'none', transport: 't',
    workflowRecord: { sourceKind: 'gate', sourceId: 'a.js:1', authorIdentity: 'g', authorType: 'Bot', observedHeadOid: c.headOid, fingerprint: c.snapshotFingerprint, semanticFingerprint: c.snapshotFingerprint } }));
  const confirmations = expected.assignedFindings.map((a) => ({ findingId: a.findingId, gate: c.gate, headOid: c.headOid, confirmation: 'confirmed', evidence: 'as designed' }));
  const envelope = { schemaVersion: 2, correlation: c, verdict: 'MERGE', evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations, decisions: [], adversarialResults: [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] };
  const runId = crypto.randomUUID(), dir = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope)); fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  fs.writeFileSync(path.join(runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: st.checkout, steps: [{ agent: 'tidd-adversarial-reviewer', status: 'complete', model: 'p/m:high', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
  return runId;
}
const prComment = (id, extra = {}) => ({ id, html_url: `u${id}`, user: { login: 'someone', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `comment ${id}`, ...extra });

test('Issue #196 Sol confirming an assigned convergence finding resolves it', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  for (const n of [1, 2]) { setFixture(t, { prComments: Array.from({ length: n }, (_, i) => prComment(i + 1)) }); drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); }
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e).stdout)?.agent, 'tidd-adversarial-reviewer');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', solConfirming(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-safety-reviewer', `${state(t.runDir).state}: ${state(t.runDir).reason}`);
});

test('Issue #196 a relaunch revalidates the target first', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.body = 'edited'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const runId = fakeGate(t.runDir, t.runs);
  fs.rmSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

test('Issue #196 the status block names only a permitted next action, and MERGE_READY carries no stale invalidation', () => {
  let t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = 'e'.repeat(40); fs.writeFileSync(t.fixture, JSON.stringify(f));
  drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.doesNotMatch(state(t.runDir).statusBlock, /next_action: .*resume/);
  t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { prComments: [prComment(1)] });
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  throughGates(t);
  // The comment's arrival started the quiet period; once it has passed, the resumed run is ready.
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW', state(t.runDir).reason);
  const st = state(t.runDir); st.changedAt = new Date(Date.now() - 180000).toISOString(); fs.writeFileSync(path.join(t.runDir, 'state.json'), JSON.stringify(st));
  drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.match(state(t.runDir).statusBlock, /^invalidated_evidence: none$/m);
  assert.equal((state(t.runDir).statusBlock.match(/tidd-convergence-reviewer/g) || []).length, 1, 'resolved lists each role once');
});

test('Issue #196 the drafted comment never carries a command substitution from untrusted text', () => {
  const t = setup({ config: { validate: [['sh', '-c', 'exit ${CODE:-0} $(true)']] } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.doesNotMatch(body, /\$\(|\$\{/);
});

test('Issue #196 a diff that is not UTF-8 stops before any gate instead of reaching it altered', () => {
  const target = makeTarget();
  git(target.root, ['checkout', '-q', 'feature']);
  fs.writeFileSync(path.join(target.root, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  git(target.root, ['add', 'l1.txt']); git(target.root, ['commit', '-q', '-m', 'latin1']);
  target.head = git(target.root, ['rev-parse', 'HEAD']); target.pull.head.sha = target.head;
  const bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.root, '--run-dir', runDir], env(bin, runs));
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(runDir).state, 'BLOCKED');
  assert.match(state(runDir).reason, /UTF-8/);
});

test('Issue #196 the bound repository is GitHub\'s canonical name, whatever --repo spelled', () => {
  const t = setup();
  const r = drive(t.start.map((a) => (a === 'o/r' ? 'O/R' : a)), t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(state(t.runDir).target.repository, 'o/r');
});

test('Issue #196 a recent external event keeps readiness in its quiet period, and the block reports quiet and window', () => {
  const t = setup();
  const now = new Date().toISOString();
  setFixture(t, { prComments: [prComment(1, { created_at: now, updated_at: now })] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.match(s.reason, /quiet period/);
  assert.match(s.external, /quiet/);
  assert.match(s.external, /window/);
});

// Round 24 of PR #199: an external record without a valid event time cannot place the quiet period, so readiness waits
// (ADV-199-MISSING-EVENT-TIMESTAMP).
test('Issue #196 an external record without a valid event time keeps readiness waiting, in every event class', () => {
  const { readiness, externalTiming } = require('../skills/closed-loop-pr/driver/run');
  const dated = '2026-09-29T00:00:00Z', origin = '2026-09-29T00:00:00Z', later = Date.parse('2026-09-29T01:00:00Z');
  const records = {
    comments: (t) => ({ comments: [{ id: 1, updated_at: t, created_at: t }] }),
    inline: (t) => ({ inline: [{ id: 1, updated_at: t, created_at: t }] }),
    reviews: (t) => ({ reviews: [{ id: 1, user: { login: 'h', type: 'User' }, state: 'COMMENTED', submitted_at: t }] }),
    threads: (t) => ({ threads: [{ id: 'T', isResolved: true, comments: { nodes: [{ id: 'c', updatedAt: t, createdAt: t }] } }] }),
    checks: (t) => ({ checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: t, completed_at: t }] }),
    statuses: (t) => ({ statuses: [{ id: 1, context: 'ci', state: 'success', created_at: t, updated_at: t }] }),
  };
  for (const [name, make] of Object.entries(records)) {
    assert.equal(externalTiming(make(dated), origin, later).quiet, null, `${name} dated`);
    for (const bad of [undefined, 'not a date']) assert.match(String(externalTiming(make(bad), origin, later).quiet), /no valid event time/, `${name} ${bad}`);
  }
  assert.equal(typeof readiness, 'function');
});

// Round 26 of PR #199: branch protection's legacy contexts count beside its checks (ADV-199-LEGACY-CONTEXT-OMITTED),
// and a quoted value never carries the publisher's observation marker (ADV-199-DRAFT-OBSERVATION-TOKEN).
test('Issue #196 branch protection contexts count beside its checks', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/run');
  const snapshot = (rsc, checks = []) => ({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks, statuses: [], reviews: [], threads: [], policies: { branchProtection: { required_status_checks: rsc }, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } });
  const pending = (s) => readiness(s, 'h'.repeat(40)).pending;
  assert.deepEqual(pending(snapshot({ contexts: ['ci/legacy'], checks: [] })), ['required check ci/legacy has not reported']);
  assert.deepEqual(pending(snapshot({ contexts: ['ci/legacy'], checks: [{ context: 'ci/modern', app_id: 123 }] })).sort(), ['required check ci/legacy has not reported', 'required check ci/modern from app 123 has not reported']);
  assert.deepEqual(pending(snapshot({ contexts: ['build'], checks: [{ context: 'build', app_id: 123 }] }, [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: 999 } }])), ['required check build from app 123 has not reported'], 'the pin still holds');
});

test('Issue #196 a quoted branch name or validation argv never carries the publisher\'s observation marker', () => {
  const t = setup({ config: { validate: [['node', '-e', '0 // observed at 0000']] } });
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.ref = 'feat/observed_from0'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  const r = spawnSync('bash', [s.publication.script], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp('i196-home-') } });
  assert.doesNotMatch(r.stderr, /observation time/, r.stderr);
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /^Reviewed public head: /m);
});

// Round 27 of PR #199: quoted values are folded as the publisher folds them, NEL included (ADV-199-PUBLISH-NEL), and a
// convergence role the parent's role preflight found disabled is skipped and reported (CL-D62, ADV-199-DISABLED-CONVERGENCE).
test('Issue #196 a quoted value with a NEL between the marker words stays publishable', () => {
  const t = setup({ config: { validate: [['node', '-e', '0 // observed\u0085at suspicious']] } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  const r = spawnSync('bash', [s.publication.script], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp('i196-home-') } });
  assert.doesNotMatch(r.stderr, /observation time/, r.stderr);
});

test('Issue #196 a convergence role found disabled is skipped and reported as convergence: disabled', () => {
  const t = setup();
  const r = drive([...t.start, '--convergence', 'disabled'], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  throughGates(t, 2);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.statusBlock, /^resolved: .*convergence: disabled/m);
  assert.match(s.statusBlock, /^rounds: convergence disabled, /m);
  assert.match(s.reason, /^convergence was disabled; Sol and Terra returned MERGE/, 'the reason names the gates that ran');
  assert.equal(s.invocations.convergence, undefined);
  assert.notEqual(drive([...setup().start, '--convergence', 'off'], t.e).status, 0, 'only the value disabled is accepted');
});

// Round 28 of PR #199: commit messages are framed by NUL, which Git never stores in one, so a message carrying U+0001
// fingerprints as itself (ADV-199-COMMIT-FRAME-CONTROL); and an observed change of external state that carries no event
// time of its own, such as a thread resolved, starts the quiet period when it is observed (ADV-199-THREAD-QUIET-UNTIMED).
test('Issue #196 a commit message carrying U+0001 fingerprints as itself', () => {
  const { prCommitsFingerprint } = require('../skills/closed-loop-pr/helpers/fingerprints');
  const target = makeTarget();
  git(target.root, ['checkout', '-q', 'feature']);
  fs.writeFileSync(path.join(target.root, 'b.js'), 'module.exports = 3;\n');
  git(target.root, ['add', 'b.js']); git(target.root, ['commit', '-q', '--cleanup=verbatim', '-m', 'feat: allow control\u0001byte\n\nbody\n']);
  target.head = git(target.root, ['rev-parse', 'HEAD']); target.pull.head.sha = target.head;
  const bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  assert.equal(drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.root, '--run-dir', runDir], env(bin, runs)).status, 0);
  const commits = git(target.root, ['rev-list', '--reverse', `${target.base}..${target.head}`]).split('\n').map((oid) => ({ oid, message: execFileSync('git', ['cat-file', 'commit', oid], { cwd: target.root, encoding: 'utf8' }).split('\n\n').slice(1).join('\n\n') }));
  assert.ok(commits[1].message.includes('\u0001'));
  assert.equal(state(runDir).fingerprints.pr_commits, prCommitsFingerprint(commits));
});

test('Issue #196 a thread resolved at final readiness starts the quiet period when it is observed', () => {
  const t = setup();
  const old = { id: 'T1', isResolved: false, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: 'c1', databaseId: 1, url: 'u', body: 'b', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } }], pageInfo: { endCursor: null, hasNextPage: false } } };
  setFixture(t, { threads: [old] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { threads: [{ ...old, isResolved: true }] });
  throughGates(t, 1);
  throughGates(t, 3);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.match(s.reason, /quiet period/);
});

// Round 29 of PR #199: any change of the snapshot, not only a new record, invalidates the gate sequence, which restarts
// at convergence (gate-contract.md, ADV-199-SNAPSHOT-INVALIDATION).
test('Issue #196 a check completing, a comment removed, or a review dismissed between gates reruns convergence', () => {
  const review = (state) => [{ id: 3, user: { login: 'h', type: 'User' }, state, body: 'r', submitted_at: '2026-09-29T00:00:00Z', commit_id: 'x' }];
  for (const [before, after] of [[{ checkStatus: 'in_progress' }, { checkStatus: 'completed' }], [{ prComments: [prComment(1)] }, { prComments: [] }], [{ reviews: review('CHANGES_REQUESTED') }, { reviews: review('DISMISSED') }]]) {
    const t = setup();
    setFixture(t, before);
    assert.equal(drive(t.start, t.e).status, 0);
    setFixture(t, after);
    const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `${JSON.stringify(after)}: ${state(t.runDir).state} ${state(t.runDir).reason}`);
  }
});

// Round 31 of PR #199: one driver command at a time holds a run; another is refused before it reads or writes
// anything, and a finished command releases the run (SAFETY-199-CONCURRENT-RESULT).
test('Issue #196 a second driver command on a held run is refused before it touches the run', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  const before = fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8');
  fs.mkdirSync(path.join(t.runDir, 'lock'));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /another driver command holds/);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8'), before, 'the run is untouched');
  const status = drive(['status', '--run-dir', t.runDir], t.e);
  assert.notEqual(status.status, 0, 'status is refused too');
  assert.match(status.stderr, /another driver command holds/);
  assert.equal(status.stdout, '');
  fs.rmdirSync(path.join(t.runDir, 'lock'));
  assert.equal(JSON.parse(drive(['status', '--run-dir', t.runDir], t.e).stdout).state, 'GATE_LAUNCH_PENDING', 'status reads the run once it is free');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(fs.existsSync(path.join(t.runDir, 'lock')), false, 'a finished command releases the run');
});

// Round 32 of PR #199: the lock's pid file is written like every other run artifact, exclusively and without
// following a link (CONV-199-LOCK-PID-NOFOLLOW).
test('Issue #196 a link planted at the lock pid path cannot alter its target', () => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const dir = temp('i196-lock-link-'), victim = path.join(temp('i196-victim-'), 'v.txt');
  fs.writeFileSync(victim, 'keep');
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (p, ...rest) => { const made = mkdir(p, ...rest); if (String(p).endsWith(`${path.sep}lock`)) fs.symlinkSync(victim, path.join(p, 'pid')); return made; };
  try { assert.throws(() => new Run(dir)); } finally { fs.mkdirSync = mkdir; }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'the failed construction releases the lock it took');
  assert.ok(new Run(dir).state, 'the run is usable afterwards');
});

// Round 35 of PR #199: a ruleset condition the snapshot cannot evaluate keeps readiness waiting for a human, even when
// every requirement of that ruleset is met (CONV-199-RULESET-UNCERTAINTY).

// Round 36 of PR #199: a ruleset whose targeting cannot be read (a ref condition without an include list, or
// ~DEFAULT_BRANCH with the default branch unknown) counts and waits for a human (ADV-199-UNKNOWN-RULESET-TARGET).

// Round 38 of PR #199: a ruleset whose target or enforcement is missing or unrecognised has unknown applicability; only
// a known non-branch target or a known inactive enforcement excludes it (CONV-199-MISSING-RULESET-TARGET).

// Owner decision https://github.com/tetsuh/pi-tidd-agents/issues/196#issuecomment-5892010180 (the PR #199 cut-off):
// readiness defers to a human what it cannot settle exactly. It never decides whether a ruleset applies or whether
// approvals satisfy it: every ruleset not known disabled that carries a rule other than deletion, non_fast_forward, or
// creation waits for a human, whatever its targeting reads (ADV-199-UNKNOWN-RULESET-SELECTOR included), and so do
// branch protection's review requirements and any other enabled protection setting the driver does not evaluate.
test('Issue #196 a ruleset that can gate a merge, and protection it does not evaluate, wait for a human', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const head = 'h'.repeat(40);
  const ci = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }];
  const approved = [{ id: 1, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-09-29T00:00:00Z' }];
  const pending = ({ rulesets = [], protection = null }) => readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: ci, statuses: [], threads: [], reviews: approved,
    policies: { branchProtection: protection, rulesets, organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head).pending;
  const ruleset = (rules, extra = {}) => ({ id: 3, name: 'gate', enforcement: 'active', target: 'branch', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules, ...extra });
  assert.deepEqual(pending({ rulesets: [ruleset([{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'creation' }])] }), [], 'rules that never gate a merge');
  assert.deepEqual(pending({ rulesets: [ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }], { enforcement: 'disabled' })] }), [], 'a disabled ruleset');
  for (const [name, set] of [['met required check', ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }])],
    ['met approval', ruleset([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }])], ['unknown rule', ruleset([{ type: 'future_rule' }])], ['unreadable rules', ruleset(undefined)],
    ['unknown selector', ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/unreported' }] } }], { conditions: { ref_name: { include: [{ future: 'all-branches' }], exclude: [] } } })],
    ['excluded by its targeting', ruleset([{ type: 'pull_request' }], { conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } } })]]) {
    assert.match(pending({ rulesets: [set] }).join(';'), /ruleset gate .*a human confirms/, name);
  }
  assert.match(pending({ protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } }).join(';'), /branch protection .*required_pull_request_reviews.*a human confirms/, 'met protection approvals');
  assert.match(pending({ protection: { required_signatures: { enabled: true } } }).join(';'), /required_signatures/, 'an enabled protection setting');
  assert.deepEqual(pending({ protection: { required_signatures: { enabled: false }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, required_status_checks: { contexts: ['ci'], checks: [] } } }), [], 'settings that are off or evaluated');
});

// Round 40 of PR #199: branch protection's `strict` (the head must be up to date with the base) is a requirement the
// driver does not settle, so it waits for a human (CONV-199-STRICT-REQUIRED-CHECKS); and a role's thinking level is
// the runner's own `thinking` field, with a model suffix only as a fallback (CONV-199-ROLE-THINKING-STATUS).
test('Issue #196 strict required checks wait for a human, and a role reports the runner\'s thinking field', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const { roleLabel } = require('../skills/closed-loop-pr/driver/run');
  const head = 'h'.repeat(40);
  const ci = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }];
  const pending = (rsc) => readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: ci, statuses: [], threads: [], reviews: [], policies: { branchProtection: { required_status_checks: rsc }, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head).pending;
  assert.match(pending({ strict: true, contexts: ['ci'], checks: [] }).join(';'), /strict.*a human confirms/);
  assert.deepEqual(pending({ strict: false, contexts: ['ci'], checks: [] }), []);
  assert.equal(roleLabel('r', 'p/m', 'high'), 'r p/m:high');
  assert.equal(roleLabel('r', 'p/m:max', 'max'), 'r p/m:max');
  assert.equal(roleLabel('r', 'p/m:max'), 'r p/m:max');
  assert.equal(roleLabel('r', 'p/m'), 'r p/m:unreported');
});

// The pre-push sweep after round 40: GitHub's own mergeability, which any reader sees, settles what an unreadable
// protection or ruleset would hide (a 404 on protection reads as unprotected to a non-admin), a branch behind its base,
// and a merge conflict; and a bot's request for changes blocks like a human's.
test('Issue #196 readiness waits unless GitHub reports the pull request mergeable, and a bot\'s request for changes blocks', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const head = 'h'.repeat(40);
  const run = (pull, reviews = []) => readiness({ pull, after: { repository: 'o/r', baseBranch: 'main' }, checks: [], statuses: [], threads: [], reviews, policies: { branchProtection: false, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head);
  for (const state of ['clean', 'unstable', 'has_hooks']) assert.deepEqual(run({ mergeable: true, mergeable_state: state }).pending, [], state);
  for (const state of ['blocked', 'behind', 'dirty', 'unknown', 'draft', null]) assert.match(run({ mergeable: state === 'dirty' ? false : null, mergeable_state: state }).pending.join(';'), /mergeable/, String(state));
  const bot = [{ id: 1, user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-09-29T00:00:00Z' }];
  assert.match(run({ mergeable: true, mergeable_state: 'clean' }, bot).failed.join(';'), /changes requested by coderabbitai\[bot\]/);
});

// Round 41 of PR #199: required linear history constrains how the pull request is merged, which the driver does not
// settle, so it waits for a human; only settings that never gate a merge are settled (ADV-199-LINEAR-HISTORY-PROTECTION).
test('Issue #196 required linear history waits for a human, and only non-gating protection settings are settled', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const pending = (bp) => readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: [], statuses: [], threads: [], reviews: [], policies: { branchProtection: bp, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, 'h'.repeat(40)).pending;
  assert.match(pending({ required_linear_history: { enabled: true } }).join(';'), /required_linear_history.*a human confirms/);
  for (const key of ['lock_branch', 'restrictions', 'required_signatures', 'a_future_setting']) assert.match(pending({ [key]: { enabled: true } }).join(';'), new RegExp(key), key);
  assert.deepEqual(pending({ url: 'u', enforce_admins: { enabled: true }, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true }, block_creations: { enabled: true }, allow_fork_syncing: { enabled: true }, required_conversation_resolution: { enabled: true } }), []);
});

// Round 42 of PR #199: every command that opens a run judges its directory as start does, so result, resume, and
// status never create a lock or write inside a Git work tree (CONV-199-RUN-DIR-OPEN-CHECK).
test('Issue #196 result, resume, and status refuse a run directory inside a work tree before writing anything', () => {
  const t = setup();
  const inside = path.join(t.target.root, 'run-inside');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'state.json'), JSON.stringify({ seq: 0, log: [], state: 'WAITING_EXTERNAL_REVIEW', pending: { gate: 'convergence' } }));
  for (const args of [['result', '--run-dir', inside, '--run-id', 'x'], ['resume', '--run-dir', inside], ['status', '--run-dir', inside]]) {
    const r = drive(args, t.e);
    assert.notEqual(r.status, 0, args[0]);
    assert.match(r.stderr, /inside a Git work tree/, args[0]);
    assert.equal(fs.existsSync(path.join(inside, 'lock')), false, `${args[0]} took no lock`);
  }
});

// The pre-push sweep after round 42: the driver's own Git calls carry the helpers' safe configuration, so a hook the
// checkout's config names never runs (core.fsmonitor set by the head's validation), and a given run directory must be
// the operator's own and closed to other writers.
test('Issue #196 the driver\'s Git never runs a configured fsmonitor, and a run directory others can write is refused', () => {
  const t = setup();
  const marker = path.join(temp('i196-hook-'), 'ran');
  const hook = path.join(temp('i196-hookbin-'), 'fsmonitor.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  git(t.target.root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['git', 'config', 'core.fsmonitor', hook]] }));
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  drive(t.start, t.e);
  assert.equal(fs.existsSync(marker), false, 'the configured fsmonitor hook never ran');
  const open = setup();
  fs.mkdirSync(open.runDir, { recursive: true }); fs.chmodSync(open.runDir, 0o777);
  const r = drive(open.start, open.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /writable by others/);
});

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
  const pull = { number: 7, state: 'open', draft: false, title: 't', body: 'Closes #5.\n', base: { sha: base, ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } } };
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
const args = process.argv.slice(2), endpoint = args[args.length - 1];
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] !== 'api') { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(9); }
if (f.failEndpoint && endpoint.includes(f.failEndpoint)) { process.stderr.write('HTTP 502: bad gateway'); process.exit(1); }
if (args[1] === 'graphql') out({ data: { repository: { pullRequest: { reviewThreads: { nodes: f.threads || [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
if (endpoint.includes('/statuses')) out(f.statuses || []);
if (endpoint === 'repos/o/r/pulls/7') out(f.pull);
if (endpoint === 'repos/o/r/issues/5') out(f.issue);
if (endpoint.startsWith('repos/o/r/issues/5/comments')) out(args.includes('--slurp') ? [[]] : []);
if (endpoint === 'repos/o/r') out({ owner: { type: 'User' }, default_branch: 'main' });
if (endpoint.endsWith('/protection')) { if (f.protection) out(f.protection); process.stderr.write('HTTP 404'); process.exit(1); }
if (endpoint === 'repos/o/r/pulls/7/reviews') out(f.reviews || []);
if (endpoint === 'repos/o/r/issues/7/comments') out(f.prComments || []);
if (endpoint.includes('/check-runs/1/annotations')) out([]);
if (endpoint.includes('/check-runs')) out({ check_runs: [{ id: 1, name: 'ci', status: f.checkStatus || 'completed', conclusion: f.checkStatus && f.checkStatus !== 'completed' ? null : (f.checkConclusion || 'success') }] });
if (endpoint.includes('/check-suites')) out({ check_suites: [] });
out([]);
`, { mode: 0o755 });
  return bin;
}

function env(bin, runs) { return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs }; }
function drive(args, e) { return spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: e, timeout: 120000 }); }
function nextRequest(stdout) { const lines = stdout.split('\n'); const i = lines.findIndex((l) => l.startsWith('NEXT:')); return i < 0 ? null : JSON.parse(lines[i + 1]); }

// The gate child, faked: a completed pi-subagents run whose structured output is a validator-accepted envelope.
function fakeGate(runDir, runs, { verdict = 'MERGE', severity = 'Major', disposition = 'fixed' } = {}) {
  const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(state.pending.expectationPath, 'utf8'));
  const c = expected.correlation;
  const prefix = { convergence: 'CONV', adversarial: 'ADV', safety: 'SAFETY' }[c.gate];
  const findings = verdict === 'MERGE' ? [] : [{ findingId: `${prefix}-${c.number}-X`, origin: 'fresh', gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity, anchoring: 'criterion-anchored', anchor: 'AC1', proposedDisposition: disposition, evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 't',
    workflowRecord: { sourceKind: 'gate', sourceId: 'a.js:1', authorIdentity: 'g', authorType: 'Bot', observedHeadOid: c.headOid, fingerprint: c.snapshotFingerprint, semanticFingerprint: c.snapshotFingerprint, correctiveChange: 'c' } }];
  const envelope = { schemaVersion: 2, correlation: c, verdict: verdict === 'MERGE' ? 'MERGE' : 'FIX BEFORE MERGE', evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations: [], decisions: [],
    adversarialResults: c.gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [] };
  const runId = crypto.randomUUID();
  const dir = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  const agent = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[c.gate];
  fs.writeFileSync(path.join(runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: state.checkout, steps: [{ agent, status: 'complete', model: 'prov/model-x:high', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
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

test('Issue #196 a missing .tidd.json at the base, or an issue without acceptance criteria, stops before any gate', () => {
  // CONV-199-MALFORMED-VALIDATION-CONFIG-TEST: a malformed file stops the run as surely as a missing one.
  for (const [options, reason] of [[{ config: null }, /\.tidd\.json/], [{ issueBody: 'Spec without criteria.\n' }, /Acceptance criteria/],
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
  assert.deepEqual(files.sort(), [`${DRIVER_DIR}/review.js`, `${DRIVER_DIR}/run.js`]);
  const sizes = files.map((f) => fs.statSync(repoPath(f)).size);
  for (const [i, size] of sizes.entries()) assert.ok(size < 30000, `${files[i]} is ${size} bytes`);
  assert.ok(sizes.reduce((a, b) => a + b, 0) < 60000, 'driver aggregate alarm');
  for (const f of files) assert.doesNotMatch(readText(f), /commit_create|push_publish|marker_create|\/merge\b|'merge'|--approve|'APPROVE'/, `${f} names a writing operation`);
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
  assert.match(s.reason, /approval/);
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
  const block = fs.readFileSync(path.join(t.runDir, 'status-block.md'), 'utf8');
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
  let r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
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
  assert.match(fs.readFileSync(path.join(t.runDir, 'status-block.md'), 'utf8'), /^  CONV-7-X: fixed \(proposed; correction pending\)$/m);
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

test('Issue #196 a .tidd.json added only at the head is not read, and the run stops BLOCKED', () => {
  const t = setup({ config: null });
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), '{"validate": [["node", "-e", "0"]]}\n');
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'add config at head']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /base commit carries no \.tidd\.json/);
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

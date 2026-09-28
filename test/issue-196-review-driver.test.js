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
if (args[1] === 'graphql') out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
if (endpoint === 'repos/o/r/pulls/7') out(f.pull);
if (endpoint === 'repos/o/r/issues/5') out(f.issue);
if (endpoint.startsWith('repos/o/r/issues/5/comments')) out(args.includes('--slurp') ? [[]] : []);
if (endpoint === 'repos/o/r') out({ owner: { type: 'User' }, default_branch: 'main' });
if (endpoint.endsWith('/protection')) { process.stderr.write('HTTP 404'); process.exit(1); }
if (endpoint.includes('/check-runs/1/annotations')) out([]);
if (endpoint.includes('/check-runs')) out({ check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }] });
if (endpoint.includes('/check-suites')) out({ check_suites: [] });
out([]);
`, { mode: 0o755 });
  return bin;
}

function env(bin, runs) { return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs }; }
function drive(args, e) { return spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: e, timeout: 120000 }); }
function nextRequest(stdout) { const lines = stdout.split('\n'); const i = lines.findIndex((l) => l.startsWith('NEXT:')); return i < 0 ? null : JSON.parse(lines[i + 1]); }

// The gate child, faked: a completed pi-subagents run whose structured output is a validator-accepted envelope.
function fakeGate(runDir, runs, { verdict = 'MERGE' } = {}) {
  const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(state.pending.expectationPath, 'utf8'));
  const c = expected.correlation;
  const prefix = { convergence: 'CONV', adversarial: 'ADV', safety: 'SAFETY' }[c.gate];
  const findings = verdict === 'MERGE' ? [] : [{ findingId: `${prefix}-${c.number}-X`, origin: 'fresh', gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity: 'Major', anchoring: 'criterion-anchored', anchor: 'AC1', proposedDisposition: 'fixed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 't',
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
  for (const f of files) assert.doesNotMatch(readText(f), /commit_create|push_publish|marker_create|\/merge\b|'merge'|--approve|APPROVE/, `${f} names a writing operation`);
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
  assert.deepEqual(s.resolved, ['convergence', 'adversarial', 'safety'].map((g) => `tidd-${g}-reviewer provider prov, model model-x, thinking high`));
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

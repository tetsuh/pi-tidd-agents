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
  if (config) fs.writeFileSync(path.join(root, '.tidd.json'), typeof config === 'string' || Buffer.isBuffer(config) ? config : `${JSON.stringify(config)}\n`);
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
if (endpoint.startsWith('repos/o/r/issues/7/comments?')) out(args.includes('--slurp') ? [f.prComments || []] : (f.prComments || []));
if (endpoint === 'repos/o/r/issues/7/comments') out(f.prComments || []);
if (/\\/check-runs\\/\\d+\\/annotations/.test(endpoint)) out([]);
if (endpoint.includes('/check-runs')) out({ check_runs: [{ id: 1, name: 'ci', started_at: '2026-09-29T00:00:00Z', ...(f.checkStatus && f.checkStatus !== 'completed' ? {} : { completed_at: '2026-09-29T00:00:00Z' }), status: f.checkStatus || 'completed', conclusion: f.checkStatus && f.checkStatus !== 'completed' ? null : (f.checkConclusion || 'success') }, ...(f.extraChecks || [])] });
if (endpoint.includes('/check-suites')) out({ check_suites: [] });
out([]);
`, { mode: 0o755 });
  return bin;
}

// The operator's configuration directory is the test's own, never the machine's (#209).
function env(bin, runs) { return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs, XDG_CONFIG_HOME: temp('i196-xdg-') }; }
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

// Round 4 of PR #199: final readiness applies the required-approval policy and new evidence, the status block is the
// contracted one, and a stopped run resumes only after every fingerprint is recomputed and found unchanged.
function setFixture(t, patch) { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); fs.writeFileSync(t.fixture, JSON.stringify({ ...f, ...patch })); }
function throughGates(t, n = 3) { let r; for (let i = 0; i < n; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); return r; }

// The pre-push conformance sweep of PR #199 (after round 4): every remaining review-only obligation the round owns.
function thread(id, resolved) { return { id, isResolved: resolved, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: `c${id}`, databaseId: 1, url: 'u', body: 'please change this', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'coderabbitai', __typename: 'Bot' } }], pageInfo: { endCursor: null, hasNextPage: false } } }; }
function publishable(runDir) { const s = state(runDir); const body = fs.readFileSync(s.publication.comment, 'utf8'); return { s, body }; }

// Round 16 of PR #199: a ruleset counts only when it is active and its conditions target this pull request's base
// branch and repository (CONV-199-RULESET-APPLICABILITY). A condition the snapshot cannot evaluate counts, so an
// unknown targeting is named for a human rather than passed over (a wait until CL-D100).

// Round 18 of PR #199: an approval counts only when it is bound to the reviewed head (CONV-199-UNBOUND-APPROVAL).

// The pre-push sweep after round 23 of PR #199: a confirmed assigned finding is resolved, a relaunch revalidates, the
// status block names only a permitted action, the drafted artifacts stay publishable, the gate receives the exact diff,
// `resolved:` lists each role once, the repository is GitHub's canonical name, and the external observation is
// reported for this run.
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

// Round 35 of PR #199: a ruleset condition the snapshot cannot evaluate is named for a human (a wait until CL-D100), even when
// every requirement of that ruleset is met (CONV-199-RULESET-UNCERTAINTY).

// Round 36 of PR #199: a ruleset whose targeting cannot be read (a ref condition without an include list, or
// ~DEFAULT_BRANCH with the default branch unknown) counts and is named for a human (ADV-199-UNKNOWN-RULESET-TARGET).

// Round 38 of PR #199: a ruleset whose target or enforcement is missing or unrecognised has unknown applicability; only
// a known non-branch target or a known inactive enforcement excludes it (CONV-199-MISSING-RULESET-TARGET).

module.exports = { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment };

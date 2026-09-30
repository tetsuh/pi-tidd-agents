'use strict';

// Shared fixtures for the packaged driver (#196): a target repository whose origin is a local bare repository, a fake
// `gh` that answers from it at call time (so a pushed commit is the public head the next read sees), and a fake gate
// child that writes a completed pi-subagents run record with a validator-accepted envelope.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim(); }

// A base commit with `.tidd.json` (unless `config` is null) and one head commit on `feature`, pushed to a bare origin;
// the checkout is on `feature` tracking it, with a commit identity of its own for the writer's commit.
function makeTarget({ config = { validate: [['node', '-e', 'process.exit(0)']] }, issueBody, files = {} } = {}) {
  const root = temp('i196-target-');
  const origin = path.join(root, 'origin.git'), checkout = path.join(root, 'checkout');
  git(root, ['init', '-q', '--bare', origin]);
  git(root, ['init', '-q', '-b', 'main', checkout]);
  git(checkout, ['config', 'user.name', 'Operator']); git(checkout, ['config', 'user.email', 'operator@example.com']);
  fs.writeFileSync(path.join(checkout, 'a.js'), 'module.exports = 1;\n');
  if (config) fs.writeFileSync(path.join(checkout, '.tidd.json'), `${JSON.stringify(config)}\n`);
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(checkout, name)), { recursive: true }); fs.writeFileSync(path.join(checkout, name), text); }
  git(checkout, ['add', '.']); git(checkout, ['commit', '-q', '-m', 'base']);
  const base = git(checkout, ['rev-parse', 'HEAD']);
  git(checkout, ['remote', 'add', 'origin', origin]);
  git(checkout, ['push', '-q', 'origin', 'main']);
  git(checkout, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(checkout, 'a.js'), 'module.exports = 2;\n');
  git(checkout, ['commit', '-q', '-am', 'feat: two (#5)']);
  git(checkout, ['push', '-q', '-u', 'origin', 'feature']);
  const head = git(checkout, ['rev-parse', 'HEAD']);
  const issue = { number: 5, body: issueBody ?? 'Spec.\n\n## Acceptance criteria\n\n- AC1: the module exports two.\n', user: { login: 'o' } };
  return { root, origin, checkout, base, head, issue, body: 'Closes #5.\n' };
}

// `gh` on PATH, answering from the fixture; the pull request's head is read from the bare origin at each call. The
// fixture file is read at each call too, so a test edits it (setFixture) to change what GitHub reports mid-run.
function fakeGh(target) {
  const bin = temp('i196-bin-');
  const fixture = path.join(bin, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ origin: target.origin, base: target.base, issue: target.issue, body: target.body }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const f = JSON.parse(require('fs').readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const head = require('child_process').execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).trim();
const args = process.argv.slice(2), endpoint = args[args.length - 1];
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] !== 'api') { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(9); }
if (f.failEndpoint && endpoint.includes(f.failEndpoint)) { process.stderr.write('HTTP 502: bad gateway'); process.exit(1); }
if (args[1] === 'graphql') out({ data: { repository: { pullRequest: { reviewThreads: { nodes: f.threads || [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
if (endpoint === 'repos/o/r/pulls/7') out({ number: 7, state: f.prState || 'open', draft: f.prDraft || false, mergeable: true, mergeable_state: 'clean', title: 't', body: f.body, base: { sha: f.base, ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: head, ref: 'feature', repo: { full_name: f.headRepo || 'o/r' } } });
if (endpoint === 'repos/o/r/issues/5') out(f.issue);
if (endpoint.startsWith('repos/o/r/issues/5/comments')) out(args.includes('--slurp') ? [f.issueComments || []] : (f.issueComments || []));
if (endpoint === 'repos/o/r/issues/7/comments') out(f.prComments || []);
if (endpoint === 'repos/o/r') out({ id: 1, owner: { type: 'User' }, default_branch: 'main', permissions: { push: true } });
if (endpoint === 'user') out({ login: 'operator' });
if (endpoint.endsWith('/protection')) { process.stderr.write('HTTP 404'); process.exit(1); }
if (endpoint.includes('/check-runs/1/annotations')) out([]);
if (endpoint.includes('/check-runs')) out({ check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }] });
if (endpoint.includes('/check-suites')) out({ check_suites: [] });
out([]);
`, { mode: 0o755 });
  return bin;
}
function setFixture(bin, patch) { const file = path.join(bin, 'fixture.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch })); }
function readFixture(bin) { return JSON.parse(fs.readFileSync(path.join(bin, 'fixture.json'), 'utf8')); }

// The gate child, faked. `fresh` adds one finding naming `path` (a criterion-anchored Major unless `severity`,
// `anchoring`, or `disposition` say otherwise; `verdict` overrides the derived one); assigned findings the expectation
// carries are returned confirmed unless `unconfirmed`; `counterexample` makes Sol link a counterexample to each of them; `sourceKind` sets the record's source (external kinds carry their required fields).
function fakeGate(runDir, runs, { fresh = false, path: findingPath = 'a.js', unconfirmed = false, severity = 'Major', anchoring = 'criterion-anchored', disposition = 'fixed', verdict: forced, counterexample = false, sourceKind = 'gate' } = {}) {
  const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(state.pending.expectationPath, 'utf8'));
  const c = expected.correlation;
  const prefix = { convergence: 'CONV', adversarial: 'ADV', safety: 'SAFETY' }[c.gate];
  const external = sourceKind === 'gate' ? {} : { sourceUrl: 'https://example.com/c/1', bodyDigest: 'e'.repeat(64), createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' };
  const record = (id) => ({ sourceKind, ...external, sourceId: `${findingPath}:1`, authorIdentity: 'g', authorType: 'Bot', observedHeadOid: c.headOid, fingerprint: c.snapshotFingerprint, semanticFingerprint: c.snapshotFingerprint, correctiveChange: `correct ${id}` });
  const finding = (findingId, origin, extra = {}) => ({ findingId, origin, gate: c.gate, headOid: c.headOid, raisedAgainstFingerprint: c.snapshotFingerprint, severity, anchoring, ...(anchoring === 'criterion-anchored' ? { anchor: 'AC1' } : {}), ...(anchoring === 'follow-up' ? { proposedIssueTitle: 'later' } : {}), proposedDisposition: disposition, evidence: `${findingPath}:1 is wrong`, impact: 'i', rationale: 'r', correction: `change ${findingPath}`, transport: 't', workflowRecord: record(findingId), ...extra });
  const assigned = (expected.assignedFindings || []).map(({ findingId, blockerKey }) => finding(findingId, 'assigned', { blockerKey, validationEvidence: 'the validation commands passed on this head' }));
  const findings = [...assigned, ...(fresh ? [finding(`${prefix}-${c.number}-X${c.invocation}`, 'fresh')] : [])];
  const confirmations = assigned.map((x) => ({ findingId: x.findingId, gate: c.gate, headOid: c.headOid, confirmation: unconfirmed ? 'rejected' : 'confirmed', evidence: 'e' }));
  const verdict = forced || (fresh || counterexample || (unconfirmed && assigned.length) ? 'FIX BEFORE MERGE' : 'MERGE');
  const envelope = { schemaVersion: 2, correlation: c, verdict, evidenceRead: expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: true })), findings, confirmations, decisions: [],
    adversarialResults: c.gate !== 'adversarial' ? [] : counterexample ? assigned.map((x) => ({ claim: 'c', searched: 's', outcome: 'counterexample', evidence: 'e', findingId: x.findingId })) : [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] };
  const runId = crypto.randomUUID();
  const dir = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  const agent = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[c.gate];
  fs.writeFileSync(path.join(runs, 'async-subagent-runs', runId, 'status.json'), JSON.stringify({ runId, state: 'complete', cwd: state.checkout, steps: [{ agent, status: 'complete', model: 'fake/fake', structuredOutputPath: path.join(dir, 'output.json'), structuredOutputSchemaPath: path.join(dir, 'schema.json') }] }));
  return runId;
}

function driverEnv(bin, runs) { return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_SUBAGENTS_TEMP_ROOT: runs }; }
function nextRequest(stdout) { const lines = stdout.split('\n'); const i = lines.findIndex((l) => l.startsWith('NEXT:')); return i < 0 ? null : JSON.parse(lines[i + 1]); }

module.exports = { temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest };

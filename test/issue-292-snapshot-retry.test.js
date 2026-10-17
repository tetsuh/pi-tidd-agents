'use strict';

// Issue #292 — on tetsuh/hekatus#129 three review-only runs passed every gate and stopped at the final snapshot, because
// one read answered HTTP 500 and `collectSnapshot` failed on the first non-404 error. The same GET in a loop failed 1
// time in 30. A 5xx answer, or a failure that carries no HTTP status, is now retried a bounded number of times with
// backoff; a 4xx answer is not, so a 404 keeps its optional-policy meaning. Each retry is reported beside the snapshot,
// never inside it, so the snapshot data and its fingerprint are those of a clean collection (CL-D44), and the driver's
// run log records it.
//
// TDD provenance: behavioural RED — one HTTP 500 fails the whole snapshot with `command_failed` before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const { collectSnapshot } = require('../skills/closed-loop-pr/helpers/snapshot');
const { snapshotFingerprint } = require('../skills/closed-loop-pr/helpers/fingerprints');
const { readText, readManifest, repoPath } = require('./helpers');

const oid = (c) => c.repeat(40);
const RULESET = 'repos/owner/repo/rulesets/7';
// The read a gh call names: its endpoint, or `graphql` for the review-thread query.
const requestOf = (args) => (args[1] === 'graphql' ? 'graphql' : String(args.at(-1)));
// GitHub's answer to the `n`th read (from 0) of `request`. With `drift`, the ruleset listing after the first read
// shows the ruleset updated, as a policy change during collection would.
function respond(request, n, drift) {
  if (request === 'repos/owner/repo/pulls/292') return { number: 292, state: 'open', draft: false, title: 't', body: 'b', base: { sha: oid('a'), ref: 'main', repo: { full_name: 'owner/repo' } }, head: { sha: oid('b'), ref: 'feature', repo: { full_name: 'owner/repo' } } };
  if (request === 'repos/owner/repo') return { owner: { type: 'User' }, default_branch: 'main' };
  if (request.endsWith('/protection')) return {};
  if (request === 'graphql') return { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
  if (request.includes('/check-runs')) return { check_runs: [] };
  if (request.includes('/check-suites')) return { check_suites: [] };
  if (request === 'repos/owner/repo/rulesets') return [{ id: 7, name: 'main', enforcement: 'active', updated_at: drift && n > 0 ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z' }];
  if (request === RULESET) return { id: 7, name: 'main', enforcement: 'active', rules: [{ type: 'pull_request' }], bypass_actors: [] };
  return [];
}
// A failed gh read with the fields the retry reads: the packaged runner's code and gh's stderr.
function ghError(stderr) {
  const error = new Error(stderr === 'timeout' ? 'command_failed:gh:SIGTERM' : 'command_failed:gh:1');
  return Object.assign(error, { code: stderr === 'timeout' ? 'command_timeout' : 'command_failed', phase: 'github_snapshot', exitCode: null, stderr: stderr === 'timeout' ? '' : stderr });
}
// `fail` maps a request to the stderr of its failing reads: an array fails the reads it lists in order, a string fails
// every read.
function transport({ fail = {}, drift = false } = {}) {
  const calls = [];
  const fn = async (_command, args) => {
    const request = requestOf(args), n = calls.filter((c) => c === request).length;
    calls.push(request);
    const plan = fail[request], failure = typeof plan === 'string' ? plan : plan?.[n];
    if (failure) throw ghError(failure);
    return { stdout: Buffer.from(JSON.stringify(respond(request, n, drift))) };
  };
  fn.count = (request) => calls.filter((c) => c === request).length;
  return fn;
}
async function snapshotWith(options) {
  const sleeps = [], t = transport(options);
  const result = await collectSnapshot({ owner: 'owner', repo: 'repo', number: 292, transport: t, sleep: async (ms) => { sleeps.push(ms); } });
  return { result, sleeps, t };
}

test('Issue #292 one HTTP 500 then success yields the complete snapshot a clean collection yields, with the retry beside it', async () => {
  const clean = await snapshotWith();
  assert.equal(clean.result.ok, true, JSON.stringify(clean.result));
  assert.equal(Object.hasOwn(clean.result, 'retries'), false, 'a clean collection reports no retries');
  const { result, sleeps, t } = await snapshotWith({ fail: { [RULESET]: ['gh: HTTP 500 (https://api.github.com/repos/owner/repo/rulesets/7)'] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.retries, [{ request: RULESET, attempt: 1, reason: 'HTTP 500' }]);
  assert.equal(t.count(RULESET), 2);
  assert.deepEqual(sleeps, [1000]);
  // The retry stays out of the data: the same snapshot, the same fingerprint, and still the producer shape that
  // `fingerprint_snapshot` requires (CL-D44).
  assert.deepEqual(result.data, clean.result.data);
  assert.equal(snapshotFingerprint(result.data), snapshotFingerprint(clean.result.data));
  assert.equal(helpers.inputShapeProblem('fingerprint_snapshot', { snapshot: result.data }), null);
});

test('Issue #292 a connection failure and a timeout, which carry no HTTP status, are retried', async () => {
  const { result } = await snapshotWith({ fail: { graphql: ['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'], 'repos/owner/repo/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs': ['timeout'] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.retries.map((r) => [r.request, r.reason]).sort(), [['graphql', 'connection failure'], [`repos/owner/repo/commits/${oid('b')}/check-runs`, 'command_timeout']]);
});

test('Issue #292 persistent HTTP 500 still fails the snapshot with command_failed after the bounded attempts', async () => {
  const { result, sleeps, t } = await snapshotWith({ fail: { [RULESET]: 'gh: HTTP 500' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'command_failed');
  assert.equal(result.error.phase, 'github_snapshot');
  assert.equal(t.count(RULESET), 3, 'three attempts in all');
  assert.deepEqual(sleeps, [1000, 2000], 'the backoff grows');
  assert.deepEqual(result.retries, [{ request: RULESET, attempt: 1, reason: 'HTTP 500' }, { request: RULESET, attempt: 2, reason: 'HTTP 500' }]);
});

test('Issue #292 a 4xx answer is not retried, and a 404 keeps its optional-policy meaning', async () => {
  const missing = await snapshotWith({ fail: { 'repos/owner/repo/branches/main/protection': 'gh: Branch not protected (HTTP 404)' } });
  assert.equal(missing.result.ok, true, JSON.stringify(missing.result));
  assert.equal(missing.result.data.policies.branchProtection, false);
  assert.equal(missing.t.count('repos/owner/repo/branches/main/protection'), 1);
  assert.equal(Object.hasOwn(missing.result, 'retries'), false);
  for (const stderr of ['gh: Resource not accessible by integration (HTTP 403)', 'gh: Validation Failed (HTTP 422)', 'gh: Not Found (HTTP 404)']) {
    const { result, sleeps, t } = await snapshotWith({ fail: { [RULESET]: stderr } });
    assert.equal(result.ok, false, stderr);
    assert.equal(result.error.code, 'command_failed', stderr);
    assert.equal(t.count(RULESET), 1, `${stderr} is read once`);
    assert.deepEqual(sleeps, [], stderr);
  }
  // A failure with no HTTP status and no connection error is not transient either.
  const other = await snapshotWith({ fail: { [RULESET]: 'gh: unknown flag --method' } });
  assert.equal(other.result.ok, false);
  assert.equal(other.t.count(RULESET), 1);
});

test('Issue #292 a retried ruleset read does not mask a policy change during collection', async () => {
  const { result } = await snapshotWith({ fail: { [RULESET]: ['gh: HTTP 502'] }, drift: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'stale_policy');
  assert.deepEqual(result.retries, [{ request: RULESET, attempt: 1, reason: 'HTTP 502' }]);
});

test('Issue #292 a read still backing off when the collection ends reads no more and records no retry', async () => {
  const COMMENTS = 'repos/owner/repo/issues/292/comments';
  const waits = [], t = transport({ fail: { [COMMENTS]: ['gh: HTTP 500'], 'repos/owner/repo/pulls/292/reviews': 'gh: Not Found (HTTP 404)' } });
  const result = await collectSnapshot({ owner: 'owner', repo: 'repo', number: 292, transport: t, sleep: () => new Promise((resolve) => { waits.push(resolve); }) });
  assert.equal(result.ok, false);
  assert.equal(waits.length, 1, 'the comments read was backing off when the collection failed');
  waits[0]();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(t.count(COMMENTS), 1, 'the read is not repeated after the collection ended');
  assert.equal(Object.hasOwn(result, 'retries'), false, 'a retry that never read again is not reported');
});

test("Issue #292 the driver's run log records a snapshot's retries", (t) => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i292-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bin = path.join(tmp, 'bin'), dir = path.join(tmp, 'run');
  fs.mkdirSync(bin); fs.mkdirSync(dir);
  // A gh on PATH that answers as `respond` does and fails the first ruleset read with HTTP 500.
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
const oid = (c) => c.repeat(40), RULESET = ${JSON.stringify(RULESET)};
const requestOf = ${requestOf.toString()};
${respond.toString()}
const request = requestOf(args);
if (request === RULESET && !fs.existsSync(${JSON.stringify(path.join(tmp, 'failed'))})) { fs.writeFileSync(${JSON.stringify(path.join(tmp, 'failed'))}, ''); process.stderr.write('gh: HTTP 500\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(respond(request, 0, false)));
`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    const run = new Run(dir);
    const result = run.op('snapshot', { owner: 'owner', repo: 'repo', number: 292, cwd: tmp }, { allowFail: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const entry = run.state.log.at(-1);
    assert.deepEqual(entry, { n: '001', operation: 'snapshot', ok: true, retries: [{ request: RULESET, attempt: 1, reason: 'HTTP 500' }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).log.at(-1), entry, 'the saved run log carries it');
  } finally { process.env.PATH = previous; }
});

test('Issue #292 CL-D37 records the one wait, and the archive of CL-D53 and CL-D71 moves their pin to CL-D92', () => {
  assert.match(readText('contract/CL-D37.md'), /#292 later allowed the helpers one wait \(owner choice, https:\/\/github\.com\/tetsuh\/pi-tidd-agents\/issues\/292#issuecomment-\d+\): `snapshot` retries a read that answers 5xx, times out or fails to connect, at most three attempts of each read, waiting 1 s and then 2 s, and the structural test exempts that one pinned block alone\. It reads the source as written: outside the block no helper names the wait, the retry or its classifier, and an escaped identifier, a shadowed global or another deliberate evasion is outside what it claims, as before #292\. No other timer or deferred work is added; widening the wait requires a new owner decision\. #292 also archived CL-D53 and CL-D71, as #235 asked; their pin is CL-D92-alarm, and CL-D57 and CL-D72 read them through this record\. Their rule stands here: trimming code merely to silence the alarm remains the recorded anti-pattern, not compliance\./);
  // #235's standing instruction, carried out because this change touches CL-D37.
  for (const id of ['CL-D53', 'CL-D71']) {
    assert.equal(fs.existsSync(repoPath(`contract/${id}.md`)) || fs.existsSync(repoPath(`contract/${id}.clauses.json`)), false, `${id} is archived`);
    assert.equal(readText('CONTRACT.md').includes(`contract/${id}.md`), false, `CONTRACT.md no longer lists ${id}`);
  }
  const alarm = readManifest().clauses.find((clause) => clause.id === 'CL-D92-alarm');
  assert.deepEqual(alarm?.requires, ['const AGGREGATE_SMOKE_ALARM = 320000;', '#264 reviewed reset from 310,000 (CL-D92)']);
});

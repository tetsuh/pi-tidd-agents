'use strict';

// Issue #193 — a review-only run on tetsuh/sitos#185 passed every gate and still ended WAITING_EXTERNAL_REVIEW: GitHub
// creates an empty check suite (zero check runs) for the CodeRabbit app on every commit, forever `queued`, while
// CodeRabbit reports through its `CodeRabbit` commit status. The parent read the empty suite as a pending review.
// Owner decision (https://github.com/tetsuh/pi-tidd-agents/issues/193#issuecomment-5857325598): an empty suite carries
// no provider state; CodeRabbit's state is its newest commit status on the head; `snapshot` emits the classification
// as `policies.externalReview`, so no parent interprets raw suites or statuses (CL-D92).
//
// TDD provenance: behavioural RED — the snapshot carries no external-review classification before the change.

const test = require('node:test');
const assert = require('node:assert/strict');

const snapshot = require('../skills/closed-loop-pr/helpers/snapshot');
const { readText } = require('./helpers');

const oid = (c) => c.repeat(40);
function transportWith({ suites = [], statuses = [] }) {
  return async (_command, args) => {
    const endpoint = String(args.at(-1));
    if (endpoint === 'repos/owner/repo/pulls/193') return { stdout: Buffer.from(JSON.stringify({ number: 193, state: 'open', draft: false, title: 't', body: 'b', base: { sha: oid('a'), ref: 'main', repo: { full_name: 'owner/repo' } }, head: { sha: oid('b'), ref: 'feature', repo: { full_name: 'owner/repo' } } })) };
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'User' }, default_branch: 'main' })) };
    if (endpoint.endsWith('/protection')) return { stdout: Buffer.from('{}') };
    if (args[1] === 'graphql') return { stdout: Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } })) };
    if (endpoint.includes('/check-runs')) return { stdout: Buffer.from(JSON.stringify({ check_runs: [] })) };
    if (endpoint.includes('/check-suites')) return { stdout: Buffer.from(JSON.stringify({ check_suites: suites })) };
    if (endpoint.includes('/statuses')) return { stdout: Buffer.from(JSON.stringify(statuses)) };
    return { stdout: Buffer.from('[]') };
  };
}
const emptySuite = { id: 1, app: { slug: 'coderabbitai' }, status: 'queued', conclusion: null, latest_check_runs_count: 0 };
const status = (state, description, created_at, id, login = 'coderabbitai[bot]') => ({ id, context: 'CodeRabbit', state, description, created_at, creator: { login } });
async function classify(input) {
  const result = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 193, transport: transportWith(input) });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data.policies.externalReview;
}

test('Issue #193 an empty queued suite beside a success status is a completed CodeRabbit review', async () => {
  const review = await classify({ suites: [emptySuite], statuses: [status('success', 'Review completed', '2026-09-27T10:00:00Z', 2)] });
  assert.deepEqual(review.map(({ provider, state, source }) => ({ provider, state, source })), [{ provider: 'coderabbit', state: 'completed', source: 'status' }]);
});

test('Issue #193 an empty suite alone detects no provider', async () => {
  assert.deepEqual(await classify({ suites: [emptySuite] }), []);
});

test('Issue #193 the newest status wins whatever order the API lists them in', async () => {
  const older = status('pending', 'Review in progress', '2026-09-27T09:00:00Z', 1);
  const newer = status('success', 'Review completed', '2026-09-27T10:00:00Z', 2);
  for (const statuses of [[older, newer], [newer, older]]) assert.equal((await classify({ statuses }))[0].state, 'completed');
  assert.equal((await classify({ statuses: [status('pending', 'Review in progress', '2026-09-27T11:00:00Z', 3), newer] }))[0].state, 'pending');
  for (const failed of ['failure', 'error']) assert.equal((await classify({ statuses: [status(failed, 'x', '2026-09-27T10:00:00Z', 4)] }))[0].state, 'failed');
});

// Pre-push adversarial review of 7e2146a: each of these failed open.
test('Issue #193 a CodeRabbit status from any other author, or with no usable time, is unknown', async () => {
  const bot = status('pending', 'Review in progress', '2026-09-27T11:00:00Z', 1);
  assert.equal((await classify({ statuses: [bot, status('success', 'Review completed', '2026-09-27T11:00:01Z', 2, 'someone')] }))[0].state, 'unknown');
  for (const created of [undefined, null, 'soon', 0]) assert.equal((await classify({ statuses: [bot, status('success', 'Review completed', created, 2)] }))[0].state, 'unknown', String(created));
  assert.equal((await classify({ statuses: [status('success', 'Review completed', '2026-09-27T10:00:00Z', 3), status('pending', 'Review in progress', 0, 4)] }))[0].state, 'unknown', 'numeric timestamp must not sort behind a valid success');
  assert.equal((await classify({ statuses: [status('success', 'Review completed', '2026-09-27T10:00:00Z', 3), status('pending', 'Review in progress', '2026-02-30T10:00:00Z', 4)] }))[0].state, 'unknown', 'impossible calendar date must not sort behind a valid success');
  // An offset is a time, not a string to sort: 20:00+09:00 is 11:00Z, older than 11:30Z.
  assert.equal((await classify({ statuses: [status('success', 'Review completed', '2026-09-27T20:00:00+09:00', 3), status('pending', 'Review in progress', '2026-09-27T11:30:00Z', 4)] }))[0].state, 'pending');
});

// Owner decision (comment 5860210273 on #193): as loose as possible; a paused or skipped review needs no action.
test('Issue #193 every success completes, whatever its description', async () => {
  for (const description of ['Review completed', 'Review paused', 'Review skipped', undefined]) assert.equal((await classify({ statuses: [status('success', description, '2026-09-27T10:00:00Z', 1)] }))[0].state, 'completed', String(description));
});

test('Issue #193 suites: any unfinished one is pending, and a count that is not a number is unknown', async () => {
  const suite = (id, status, conclusion, count = 1) => ({ id, app: { slug: 'coderabbitai' }, status, conclusion, latest_check_runs_count: count });
  assert.equal((await classify({ suites: [suite(1, 'completed', 'success'), suite(2, 'in_progress', null)] }))[0].state, 'pending');
  assert.equal((await classify({ suites: [suite(2, 'completed', 'failure'), suite(1, 'completed', 'success')] }))[0].state, 'failed');
  const uncounted = suite(1, 'completed', 'success'); delete uncounted.latest_check_runs_count;
  for (const shape of [uncounted, suite(1, 'completed', 'success', null), suite(1, 'completed', 'success', '1')]) assert.equal((await classify({ suites: [shape] }))[0].state, 'unknown', JSON.stringify(shape));
  assert.deepEqual(await classify({ suites: [emptySuite, { id: 9, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', latest_check_runs_count: 3 }] }), []);
});

test('Issue #193 unestablished status and suite fields classify as unknown', async () => {
  const suite = (status, count = 1) => ({ id: 1, app: { slug: 'coderabbitai' }, status, conclusion: 'success', latest_check_runs_count: count });
  const cases = [
    ['negative run count', { suites: [suite('completed', -1)] }],
    ['__proto__ status state', { statuses: [status('__proto__', 'x', '2026-09-27T10:00:00Z', 1)] }],
    ['toString status state', { statuses: [status('toString', 'x', '2026-09-27T10:00:00Z', 1)] }],
    ['unrecognized suite status', { suites: [suite('mystery')] }],
  ];
  for (const [name, input] of cases) assert.equal((await classify(input))[0]?.state, 'unknown', name);
});

test('Issue #193 a non-empty CodeRabbit suite is read only when no status exists', async () => {
  const running = { id: 5, app: { slug: 'coderabbitai' }, status: 'in_progress', conclusion: null, latest_check_runs_count: 1 };
  const done = { ...running, status: 'completed', conclusion: 'success' };
  const failed = { ...running, status: 'completed', conclusion: 'failure' };
  assert.deepEqual((await classify({ suites: [running] })).map((r) => [r.state, r.source]), [['pending', 'check_suite']]);
  assert.equal((await classify({ suites: [done] }))[0].state, 'completed');
  assert.equal((await classify({ suites: [failed] }))[0].state, 'failed');
  for (const conclusion of [null, undefined, 'future_conclusion']) {
    const unknown = { ...done, id: 2, conclusion };
    assert.equal((await classify({ suites: [unknown] }))[0].state, 'unknown', String(conclusion));
    assert.equal((await classify({ suites: [{ ...done, id: 1 }, unknown] }))[0].state, 'unknown', `newer ${conclusion} must not inherit an older success`);
  }
  assert.deepEqual((await classify({ suites: [running], statuses: [status('success', 'Review completed', '2026-09-27T10:00:00Z', 6)] })).map((r) => [r.state, r.source]), [['completed', 'status']]);
});

test('Issue #193 both roots read the classification instead of raw suites', () => {
  for (const file of ['skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/autofix-addendum.md']) {
    const text = readText(file);
    assert.match(text, /policies\.externalReview/, file);
    assert.match(text, /empty check suite/i, file);
    assert.match(text, /`unknown` is not complete/, file);
  }
  assert.match(readText('CONTRACT.md'), /^## CL-D92 — /m);
});

// Owner decision https://github.com/tetsuh/pi-tidd-agents/issues/193#issuecomment-5869141430: the writer's correction
// of PR #195's convergence findings measured 300,068 bytes, so CL-D92 resets the aggregate helper alarm to 310,000.
test('Issue #193 CL-D92 resets the aggregate helper alarm to 310,000, with headroom asserted at the raise', () => {
  assert.match(readText('test/issue-59-helper-surface.test.js'), /const AGGREGATE_SMOKE_ALARM = 310000; \/\/ CL-D92 reviewed reset from 300,000 \(CL-D91\)/);
  assert.match(readText('test/package.test.js'), /helperBytes < 310000/);
  assert.match(readText('CONTRACT.md'), /CL-D92 reset it a tenth time to 310,000 bytes/);
  assert.ok(310000 - 300068 > 9000, 'CL-D92 measured 300,068 bytes at the raise');
});

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
const status = (state, description, created_at, id) => ({ id, context: 'CodeRabbit', state, description, created_at });
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

test('Issue #193 a non-empty CodeRabbit suite is read only when no status exists', async () => {
  const running = { id: 5, app: { slug: 'coderabbitai' }, status: 'in_progress', conclusion: null, latest_check_runs_count: 1 };
  const done = { ...running, status: 'completed', conclusion: 'success' };
  const failed = { ...running, status: 'completed', conclusion: 'failure' };
  assert.deepEqual((await classify({ suites: [running] })).map((r) => [r.state, r.source]), [['pending', 'check_suite']]);
  assert.equal((await classify({ suites: [done] }))[0].state, 'completed');
  assert.equal((await classify({ suites: [failed] }))[0].state, 'failed');
  assert.deepEqual((await classify({ suites: [running], statuses: [status('success', 'Review completed', '2026-09-27T10:00:00Z', 6)] })).map((r) => [r.state, r.source]), [['completed', 'status']]);
});

test('Issue #193 both roots read the classification instead of raw suites', () => {
  for (const file of ['skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/autofix-addendum.md']) {
    const text = readText(file);
    assert.match(text, /policies\.externalReview/, file);
    assert.match(text, /empty check suite/i, file);
  }
  assert.match(readText('CONTRACT.md'), /^## CL-D92 — /m);
});

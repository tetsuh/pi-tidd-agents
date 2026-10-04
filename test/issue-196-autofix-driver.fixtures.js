'use strict';

// Issue #196 PR-B — the packaged exact-autofix driver (CL-D96). The #191 spike took PR #195 to MERGE_READY without
// rescue (milestone #155). Here a local bare origin stands in for GitHub: the fake `gh` reads the pull request's head
// from it, so the writer's real `pre-edit` and `batch` (every packaged guard, `commit_create`, `push_publish`) move the
// public head the driver then re-reviews.
//
// TDD provenance: behavioural RED — no packaged autofix driver exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { repoPath, readText } = require('./helpers');
const { temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest } = require('./driver-fixtures');

const DRIVER = repoPath('skills/closed-loop-pr/driver/autofix.js');
function drive(args, env, cwd) { return spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env, cwd, timeout: 300000 }); }
function setup(options) {
  const target = makeTarget(options), bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  return { target, bin, env: driverEnv(bin, runs), runs, runDir, start: ['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.checkout, '--run-dir', runDir] };
}
const state = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
const originHead = (t) => git(t.target.root, ['--git-dir', t.target.origin, 'rev-parse', 'refs/heads/feature']);

// PR #199's review-only hardening holds for the autofix driver too: it shares the review driver's target binding,
// gate-result reading, revalidation, evidence identities, and final readiness policy (CL-D96).
const result = (t, options) => drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, options)], t.env);
function thread(id, resolved) { return { id, isResolved: resolved, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: `c${id}`, databaseId: 1, url: 'u', body: 'please change this', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'coderabbitai', __typename: 'Bot' } }], pageInfo: { endCursor: null, hasNextPage: false } } }; }

// The pre-push adversarial review of PR-B: exact autofix keeps CL-D51's relaunch key (autofix.md), the async writer is
// read before its batch is judged, and a failed terminal operator recheck is a BLOCKED stop.
// The runner's id for the writer of the current batch: a UUID, one per push, as the runner gives each run its own.
const writerId = (t) => `00000000-0000-4000-8000-${String(state(t.runDir).counters.pushes + 1).padStart(12, '0')}`;
// writer-done reads the writer's own runner record: an explicit terminal state for the autofix worker, never an absence.
function writerStatus(t, runState = 'complete') {
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'status.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ runId: writerId(t), state: runState, cwd: state(t.runDir).workspace, startedAt: Date.now(), steps: [{ agent: 'tidd-autofix-worker', status: runState }] }));
}
function writerDone(t) { writerStatus(t); return drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env); }
const outputPath = (t, runId) => JSON.parse(fs.readFileSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'), 'utf8')).steps[0].structuredOutputPath;
function writerBatch(t, content) {
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), content);
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  return writerDone(t);
}

// Issue #196 AC2's refusals and caps, each at its boundary (CONV-208-EMPTY-EDIT-TEST, CONV-208-AUTOFIX-CAPS-TEST).
// Reaching a cap by real cycles costs a push each, so a counter is set one short of it in state.json and the next
// step is driven; the step itself is the driver's own code.
const setCounters = (t, patch) => { const file = path.join(t.runDir, 'state.json'), s = state(t.runDir); Object.assign(s.counters, patch); fs.writeFileSync(file, JSON.stringify(s)); };

module.exports = { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters };

'use strict';

// Issue #140. The exact-autofix grant allows up to five correction pushes per run, but the post-push guard accepted
// only a sole child of the operator baseline, so the run's second push ended it BLOCKED (PR #139, 2026-09-18). The
// run now names the heads it pushed before the current one, oldest first, as `priorPushHeads`; the guard accepts the
// chain only when each head is the sole child of the one before it, the first of the baseline, the last is the
// tracking ref, and the chain is at most five long (owner choice, issues/140, recorded as CL-D79).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');

const oid = (character) => character.repeat(40);
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const commitEnv = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function withOperator(run) {
  const root = temp('issue-140-repo-'); const bare = temp('issue-140-origin-');
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 140 Test']); git(root, ['config', 'user.email', 'issue140@example.invalid']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
    git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
    git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', '-u', 'origin', 'main']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const identity = { repository: 'owner/repo', prNumber: 140, lifecycle: 'OPEN', baseOid: oid('a'), publicHead: head, headRepository: 'owner/repo', headBranch: 'main', originFetch: bare, originPush: bare };
    const captured = helpers.captureOperatorCheckout({ cwd: root, identity });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    // A commit on top of `parent` with the same tree, as a correction pushed from the workspace would be; the push
    // itself is modelled by moving the remote-tracking ref the linked workspace shares with the operator checkout.
    const child = (parent, ...extraParents) => git(root, ['commit-tree', 'HEAD^{tree}', '-p', parent, ...extraParents.flatMap((p) => ['-p', p]), '-m', 'fix: correction'], commitEnv);
    const track = (commit) => git(root, ['update-ref', 'refs/remotes/origin/main', commit]);
    const revalidate = (postPushHead, priorPushHeads) => helpers.revalidateOperatorCheckout(captured, { cwd: root, postPushHead, ...(priorPushHeads === undefined ? {} : { priorPushHeads }) });
    run({ root, head, child, track, revalidate, captured });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true }); }
}

test('Issue #140 a second pushed correction is accepted when the run names the first', () => {
  withOperator(({ head, child, track, revalidate }) => {
    const first = child(head); const second = child(first);
    track(second);
    const accepted = revalidate(second, [first]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    // Without the run's record of its first push, the grandchild is still refused, as before.
    const unnamed = revalidate(second);
    assert.deepEqual([unnamed.ok, unnamed.error?.code], [false, 'operator_changed']);
  });
});

test('Issue #140 the chain reaches the five-push cap and no further', () => {
  withOperator(({ head, child, track, revalidate }) => {
    const pushed = [];
    let tip = head;
    for (let i = 0; i < 6; i += 1) { tip = child(tip); pushed.push(tip); }
    track(pushed[4]);
    const fifth = revalidate(pushed[4], pushed.slice(0, 4));
    assert.equal(fifth.ok, true, JSON.stringify(fifth.error));
    track(pushed[5]);
    const sixth = revalidate(pushed[5], pushed.slice(0, 5));
    assert.deepEqual([sixth.ok, sixth.error?.code], [false, 'operator_changed'], JSON.stringify(sixth));
  });
});

// The guard checks the chain it is given, not who pushed it (CL-D79, owner choice B): these are the ways a chain
// that omits, reorders, or starts past a head fails, whatever pushed that head.
test('Issue #140 a chain that leaves out, reorders, or starts past a head is refused', () => {
  withOperator(({ head, child, track, revalidate }) => {
    const first = child(head);
    const foreign = child(first); // pushed by someone else between the run's two pushes
    const second = child(foreign);
    track(second);
    for (const [label, prior] of [['the foreign head omitted', [first]], ['the list out of order', [foreign, first]], ['the first head not a child of the baseline', [foreign]]]) {
      const refused = revalidate(second, prior);
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'operator_changed'], `${label}: ${JSON.stringify(refused)}`);
    }
  });
});

test('Issue #140 a merge anywhere in the chain is refused', () => {
  withOperator(({ root, head, child, track, revalidate }) => {
    const side = git(root, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated'], commitEnv);
    const first = child(head, side); // two parents
    const second = child(first);
    track(second);
    const refused = revalidate(second, [first]);
    assert.deepEqual([refused.ok, refused.error?.code], [false, 'operator_changed'], JSON.stringify(refused));
  });
});

test('Issue #140 the chain must end at the tracking ref and be well formed', () => {
  withOperator(({ head, child, track, revalidate }) => {
    const first = child(head); const second = child(first);
    track(first);
    const behind = revalidate(second, [first]);
    assert.deepEqual([behind.ok, behind.error?.code], [false, 'operator_changed'], 'the tracking ref is not the last head');
    track(second);
    for (const [label, prior] of [['not an array', first], ['an object', { 0: first }], ['a non-OID entry', ['main']], ['a repeated head', [first, first]], ['the current head repeated', [first, second]]]) {
      const refused = revalidate(second, prior);
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'operator_changed'], `${label}: ${JSON.stringify(refused)}`);
    }
    // Earlier pushes with no current one: the tracking ref back at the baseline would otherwise pass unchanged.
    track(head);
    const alone = revalidate(undefined, [first]);
    assert.deepEqual([alone.ok, alone.error?.code], [false, 'operator_changed'], 'priorPushHeads without postPushHead is not a request');
  });
});

test('Issue #140 the builder carries priorPushHeads beside postPushHead and refuses it otherwise', () => {
  withOperator(({ root, head, child, track, captured }) => {
    const first = child(head); const second = child(first);
    track(second);
    const built = helpers.buildOperatorRevalidate({ captured: captured.data, cwd: root, postPushHead: second, priorPushHeads: [first] });
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.deepEqual(built.data.request.data.priorPushHeads, [first]);
    for (const [label, data] of [
      ['without postPushHead', { priorPushHeads: [first] }],
      ['five earlier heads', { postPushHead: second, priorPushHeads: [oid('1'), oid('2'), oid('3'), oid('4'), oid('5')] }],
      ['not an array', { postPushHead: second, priorPushHeads: first }],
      ['a non-OID entry', { postPushHead: second, priorPushHeads: ['main'] }],
      // A hole is skipped by every(); the boundary would refuse the list it produces (CONV-147-BUILDER-SPARSE-CHAIN-GAP).
      ['a sparse array', { postPushHead: second, priorPushHeads: [, first] }], // eslint-disable-line no-sparse-arrays
    ]) {
      const refused = helpers.buildOperatorRevalidate({ captured: captured.data, cwd: root, ...data });
      assert.deepEqual([refused.ok, refused.error?.code, refused.error?.phase], [false, 'invalid_request', 'build'], label);
    }
  });
});

test('Issue #140 the packaged CLI carries the chain from the builder to the guard', () => {
  withOperator(({ root, head, child, track }) => {
    // The path a run takes: capture, build the revalidation request, run it, each through the packaged CLI.
    const { spawnSync } = require('node:child_process');
    const CLI = require('path').resolve(__dirname, '../skills/closed-loop-pr/helpers/cli.js');
    const cli = (operation, data) => JSON.parse(spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' }).stdout);
    const bare = git(root, ['remote', 'get-url', 'origin']);
    const capture = cli('operator_capture', { cwd: root, identity: { repository: 'owner/repo', prNumber: 140, lifecycle: 'OPEN', baseOid: oid('a'), publicHead: head, headRepository: 'owner/repo', headBranch: 'main', originFetch: bare, originPush: bare } });
    assert.equal(capture.ok, true, JSON.stringify(capture.error));
    const first = child(head); const second = child(first);
    track(second);
    const run = (extra) => {
      const built = cli('build_operator_revalidate', { captured: capture, cwd: root, postPushHead: second, ...extra });
      assert.equal(built.ok, true, JSON.stringify(built.error));
      return cli(built.data.request.operation, built.data.request.data);
    };
    const accepted = run({ priorPushHeads: [first] });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    const refused = run({});
    assert.deepEqual([refused.ok, refused.error?.code], [false, 'operator_changed'], JSON.stringify(refused));
    // A null list is not an empty one: the direct operation refuses it as the builder does.
    track(first);
    const sole = cli('operator_revalidate', { captured: capture, cwd: root, postPushHead: first });
    assert.equal(sole.ok, true, 'the same request without the null list passes');
    const nulled = cli('operator_revalidate', { captured: capture, cwd: root, postPushHead: first, priorPushHeads: null });
    assert.deepEqual([nulled.ok, nulled.error?.code], [false, 'operator_changed'], JSON.stringify(nulled));
  });
});

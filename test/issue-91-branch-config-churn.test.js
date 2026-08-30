'use strict';

// Issue #91 (CL-D52) — the operator stability digest ignores branch-scoped configuration for
// branches other than the checked-out one, so linked-worktree parallel development stops
// killing live reviews. Two BLOCKED runs (PR #77: push -u; PR #90: checkout -b auto-tracking)
// each moved the digest with a foreign [branch] entry the reviewed run never reads. Everything
// else — the current branch's own tracking, every non-branch key, the unsafe-key scan over the
// full configuration, and the mid-preflight raw-byte instability check — is unchanged.
//
// TDD provenance: recorded with the focused command below at 0 passes: the tolerance scenarios
// are behavioral RED against the all-bytes digest, and the record scenario is compile/contract
// RED. That local output is not claimed as repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { assertSafeRepositoryConfig } = require('../skills/closed-loop-pr/helpers/process');
const { readText, sectionOf } = require('./helpers');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-91-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 91 Test']);
  git(root, ['config', 'user.email', 'issue91@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'test: base']);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-91-origin-'));
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']) };
}
function capture(repo) {
  return helpers.captureOperatorCheckout({
    cwd: repo.root,
    identity: {
      repository: 'owner/repo', prNumber: 91, lifecycle: 'OPEN',
      baseOid: 'a'.repeat(40), publicHead: repo.head, headRepository: 'owner/repo',
      headBranch: 'main', originFetch: repo.bare, originPush: repo.bare,
    },
  });
}
function cleanup(repo) {
  fs.rmSync(repo.root, { recursive: true, force: true });
  fs.rmSync(repo.bare, { recursive: true, force: true });
}

test('Issue #91 foreign-branch config churn does not move the operator baseline', () => {
  const repo = repository();
  try {
    const captured = capture(repo);
    assert.equal(captured.ok, true, JSON.stringify(captured.error ?? {}));

    // The two observed incident shapes: a tracking entry appearing for another branch, and for
    // a dotted branch name, exactly what push -u and checkout -b auto-tracking write.
    git(repo.root, ['config', 'branch.feat/parallel-work.remote', 'origin']);
    git(repo.root, ['config', 'branch.feat/parallel-work.merge', 'refs/heads/main']);
    git(repo.root, ['config', 'branch.release.v1.2.remote', 'origin']);
    const revalidated = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(revalidated.ok, true, JSON.stringify(revalidated.error ?? {}));

    // Removal churns too, and must be equally invisible.
    git(repo.root, ['config', '--remove-section', 'branch.feat/parallel-work']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, true);
  } finally { cleanup(repo); }
});

test('Issue #91 the current branch, non-branch keys, and unsafe keys still fail closed', () => {
  const repo = repository();
  try {
    const captured = capture(repo);
    assert.equal(captured.ok, true, JSON.stringify(captured.error ?? {}));

    // The checked-out branch's own tracking is baseline-relevant.
    git(repo.root, ['config', 'branch.main.merge', 'refs/heads/other']);
    const movedTracking = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(movedTracking.ok, false, 'current-branch tracking movement must fail closed');
    git(repo.root, ['config', 'branch.main.merge', 'refs/heads/main']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, true, 'restored tracking must revalidate');

    // Any non-branch key still moves the digest.
    git(repo.root, ['config', 'user.name', 'Someone Else']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, false, 'non-branch config movement must fail closed');
    git(repo.root, ['config', 'user.name', 'Issue 91 Test']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, true);

    // An unsafe key is refused wherever it sits, foreign branch sections included — the scan
    // covers the full configuration regardless of digest normalization.
    git(repo.root, ['config', 'filter.evil.clean', 'cat']);
    const unsafe = capture(repo);
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.error.code, 'unsafe_git_config');
  } finally { cleanup(repo); }
});

test('Issue #91 the digest itself pins the current branch and only the current branch', () => {
  // Direct probes of the primitive: the operator-level scenarios above are masked for the
  // current branch by the separately captured tracking fields, so the digest's own behavior
  // is asserted here where nothing shadows it.
  const repo = repository();
  try {
    const base = assertSafeRepositoryConfig(repo.root);
    git(repo.root, ['config', 'branch.feat/other.rebase', 'true']);
    assert.equal(assertSafeRepositoryConfig(repo.root), base, 'a foreign branch entry must not move the digest');
    git(repo.root, ['config', 'branch.main.rebase', 'true']);
    assert.notEqual(assertSafeRepositoryConfig(repo.root), base, "the current branch's own entry must move the digest");
    git(repo.root, ['config', '--unset', 'branch.main.rebase']);
    assert.equal(assertSafeRepositoryConfig(repo.root), base, 'restoring the current branch restores the digest');

    // A dotted current branch is parsed as the full subsection, not up to the first dot.
    git(repo.root, ['checkout', '-q', '-b', 'release.v1.2']);
    const dotted = assertSafeRepositoryConfig(repo.root);
    git(repo.root, ['config', 'branch.release.v1.2.rebase', 'true']);
    assert.notEqual(assertSafeRepositoryConfig(repo.root), dotted, "a dotted current branch's entry must move the digest");
  } finally { cleanup(repo); }
});

test('Issue #91 detached HEAD ignores every branch section', () => {
  const repo = repository();
  try {
    git(repo.root, ['checkout', '-q', '--detach', repo.head]);
    // Detached operator capture fails on branch identity, so probe the digest primitive
    // directly: with no current branch, no branch section may enter the digest.
    const before = assertSafeRepositoryConfig(repo.root);
    git(repo.root, ['config', 'branch.main.rebase', 'true']);
    const after = assertSafeRepositoryConfig(repo.root);
    assert.equal(before, after, 'a branch entry must not move a detached digest');
    git(repo.root, ['config', 'user.name', 'Someone Else']);
    assert.notEqual(assertSafeRepositoryConfig(repo.root), after, 'non-branch keys still move it');
  } finally { cleanup(repo); }
});

test('Issue #91 CL-D52 records what the digest ignores and why that is safe here', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D52 — The stability digest ignores foreign-branch configuration');
  assert.ok(decision, 'CONTRACT.md must record CL-D52');
  for (const field of ['*Decision ID:* CL-D52', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D52 must carry ${field}`);
  }
  assert.match(decision, /the reviewed run never reads a foreign branch's configuration/);
  assert.match(decision, /the unsafe-key scan keeps covering the full configuration/);
});

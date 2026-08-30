'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText } = require('./helpers');

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function makeRepository() {
  const root = temp('i69-repo-');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 69 Test']);
  git(root, ['config', 'user.email', 'issue69@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'test: base']);
  const bare = temp('i69-origin-');
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}
function pathKey(value) {
  const absolute = path.resolve(value);
  let current = absolute;
  const missing = [];
  for (;;) {
    try {
      const resolved = path.join(fs.realpathSync.native(current), ...missing);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function samePathIdentity(left, right) {
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}
function registration(repo, workspace) {
  return helpers.parseWorktrees(repo).find((entry) => entry.worktree && pathKey(entry.worktree) === pathKey(workspace));
}
function removeRegistration(repo, workspace) {
  const record = registration(repo, workspace);
  if (!record) return;
  try { git(repo, ['worktree', 'remove', record.worktree]); }
  catch { git(repo, ['worktree', 'remove', '--force', record.worktree]); }
}
function makeStale(repo, workspace, args = ['--detach']) {
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  git(repo.root, ['worktree', 'add', ...args, workspace, repo.head]);
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  const record = registration(repo.root, workspace);
  assert.ok(record, 'test fixture must retain a registration');
  return record;
}

const AUTOFIX = (readText('skills/closed-loop-pr/references/autofix.md') + '\n' + readText('skills/closed-loop-pr/references/autofix-addendum.md'));
const CONTRACT = readText('CONTRACT.md');
const README = readText('README.md');

// TDD provenance: before implementation, the focused command below produced 1 pass/4 failures.
// The authority-presence scenario is pre-implementation compile/contract RED. The unrelated-missing,
// exact-collision, and wrong-HEAD/attached-branch scenarios are pre-implementation behavioral RED.
// The original missing-registration/default-root success and workspace-leaf symlink scenarios are co-developed integration coverage.
// Missing-registration failure classification, receipt-failure, locked-registration, file-ancestor, symlink-ancestor, and Windows
// routing are review-driven regressions. The local
// RED output is not claimed as repository-preserved or runtime-compliance evidence.

test('Issue #69 authority forbids broad prune advice and scopes exact external recovery', () => {
  for (const source of [AUTOFIX, CONTRACT, README]) {
    assert.match(source, /missing path.*does not prove.*stale.*registration/is);
    assert.match(source, /never recommend.*git worktree prune/is);
    assert.match(source, /non-force.*git worktree remove.*exact/is);
  }
  assert.match(AUTOFIX, /new owner action outside the failed run/i);
  assert.match(AUTOFIX, /unverifiable.*no mutation command/i);
  assert.match(CONTRACT, /CL-D40/);
});

test('Issue #69 unrelated missing registrations cannot break a fresh linked workspace', async () => {
  const repo = makeRepository();
  const parent = temp('i69-unrelated-stale-');
  const stalePath = path.join(parent, 'a-stale-root', 'workspace');
  const fileAncestorPath = path.join(parent, 'b-file-ancestor-root', 'workspace');
  const freshRoot = path.join(parent, 'z-fresh-root');
  const freshPath = path.join(freshRoot, 'workspace');
  let created;
  try {
    makeStale(repo, stalePath);
    makeStale(repo, fileAncestorPath);
    fs.writeFileSync(path.dirname(fileAncestorPath), 'replaced by file\n');
    created = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot: freshRoot, allowCloneFallback: false });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(registration(repo.root, stalePath), 'unrelated stale registration must remain untouched');
    assert.ok(registration(repo.root, fileAncestorPath), 'an unrelated ENOTDIR registration must remain untouched');
    assert.ok(registration(repo.root, freshPath), 'fresh exact registration must be selected despite unrelated ENOENT entries');
    const cleaned = await helpers.cleanupWorkspace(created.data.receipt, repo.root);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    created = null;
    assert.ok(registration(repo.root, stalePath), 'normal cleanup must not prune unrelated registrations');
  } finally {
    if (created?.data?.path) removeRegistration(repo.root, created.data.path);
    removeRegistration(repo.root, freshPath);
    removeRegistration(repo.root, fileAncestorPath);
    removeRegistration(repo.root, stalePath);
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 exact missing registration collision returns bounded read-only evidence', () => {
  const repo = makeRepository();
  const parent = temp('i69-two-stale-');
  const selectedRoot = path.join(parent, 'selected-root');
  const otherRoot = path.join(parent, 'other-root');
  const selected = path.join(selectedRoot, 'workspace');
  const other = path.join(otherRoot, 'workspace');
  try {
    makeStale(repo, selected);
    makeStale(repo, other);
    const before = helpers.parseWorktrees(repo.root);
    const result = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot: selectedRoot, allowCloneFallback: false });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'workspace_registration_collision');
    const evidence = result.error.details.recovery;
    assert.equal(evidence.classification, 'exact_missing_detached_registration');
    assert.equal(samePathIdentity(evidence.repository, repo.root), true);
    assert.equal(samePathIdentity(evidence.commonGitDir, path.join(repo.root, '.git')), true);
    assert.equal(pathKey(evidence.workspacePath), pathKey(selected));
    assert.equal(evidence.expectedHead, repo.head);
    assert.equal(evidence.pathKind, 'absent');
    assert.equal(evidence.followed, false);
    assert.equal(pathKey(evidence.registration.worktree), pathKey(selected));
    assert.equal(evidence.registration.head, repo.head);
    assert.equal(evidence.registration.detached, true);
    assert.equal(evidence.registration.branch, null);
    assert.equal(evidence.registration.prunable.present, true);
    assert.equal(typeof evidence.registration.prunable.reason, 'string');
    assert.ok(evidence.registration.prunable.reason.length > 0);
    assert.deepEqual(evidence.registration.locked, { present: false, reason: null });
    assert.equal(evidence.receiptPresent, false);
    assert.equal(evidence.validRunOwnedReceipt, false);
    assert.equal(evidence.runRootSource, 'explicit');
    assert.equal(evidence.exactRemovalCandidate, true);
    assert.deepEqual(helpers.parseWorktrees(repo.root), before, 'failed run must not mutate either stale registration');

    // This models the separately authorized operator action. The helper never runs it.
    git(repo.root, ['worktree', 'remove', selected]);
    assert.equal(registration(repo.root, selected), undefined);
    assert.ok(registration(repo.root, other), 'exact-path remove must leave the unrelated stale registration');
  } finally {
    removeRegistration(repo.root, selected);
    removeRegistration(repo.root, other);
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 wrong-head and branch registrations never become exact removal candidates', () => {
  const repo = makeRepository();
  const parent = temp('i69-ineligible-');
  const wrongRoot = path.join(parent, 'wrong-root');
  const branchRoot = path.join(parent, 'branch-root');
  const wrong = path.join(wrongRoot, 'workspace');
  const attached = path.join(branchRoot, 'workspace');
  try {
    makeStale(repo, wrong);
    fs.writeFileSync(path.join(repo.root, 'second.txt'), 'second\n');
    git(repo.root, ['add', 'second.txt']);
    git(repo.root, ['commit', '-m', 'test: second']);
    const currentHead = git(repo.root, ['rev-parse', 'HEAD']);
    const currentTree = git(repo.root, ['rev-parse', 'HEAD^{tree}']);

    fs.mkdirSync(path.dirname(attached), { recursive: true });
    git(repo.root, ['worktree', 'add', '-b', 'issue-69-attached', attached, currentHead]);
    fs.rmSync(path.dirname(attached), { recursive: true, force: true });

    const wrongResult = helpers.createWorkspace({ cwd: repo.root, head: currentHead, tree: currentTree, runRoot: wrongRoot, allowCloneFallback: false });
    assert.equal(wrongResult.error.code, 'workspace_registration_collision');
    assert.equal(wrongResult.error.details.recovery.classification, 'registration_identity_mismatch');
    assert.equal(wrongResult.error.details.recovery.exactRemovalCandidate, false);
    assert.equal(wrongResult.error.details.recovery.registration.head, repo.head);

    const branchResult = helpers.createWorkspace({ cwd: repo.root, head: currentHead, tree: currentTree, runRoot: branchRoot, allowCloneFallback: false });
    assert.equal(branchResult.error.code, 'workspace_registration_collision');
    assert.equal(branchResult.error.details.recovery.classification, 'registration_identity_mismatch');
    assert.equal(branchResult.error.details.recovery.exactRemovalCandidate, false);
    assert.equal(branchResult.error.details.recovery.detached, undefined);
    assert.equal(branchResult.error.details.recovery.registration.detached, false);
    assert.equal(branchResult.error.details.recovery.registration.branch, 'refs/heads/issue-69-attached');
  } finally {
    removeRegistration(repo.root, wrong);
    removeRegistration(repo.root, attached);
    try { git(repo.root, ['branch', '-D', 'issue-69-attached']); } catch {}
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 locked missing registrations never become exact removal candidates', () => {
  const repo = makeRepository();
  const parent = temp('i69-locked-');
  const runRoot = path.join(parent, 'locked-root');
  const workspace = path.join(runRoot, 'workspace');
  try {
    fs.mkdirSync(runRoot, { recursive: true });
    git(repo.root, ['worktree', 'add', '--detach', workspace, repo.head]);
    git(repo.root, ['worktree', 'lock', '--reason', 'operator keep', workspace]);
    fs.rmSync(runRoot, { recursive: true, force: true });
    const result = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(result.error.code, 'workspace_registration_collision');
    assert.equal(result.error.details.recovery.classification, 'registration_identity_mismatch');
    assert.equal(result.error.details.recovery.registration.locked.present, true);
    assert.equal(result.error.details.recovery.registration.locked.reason, 'operator keep');
    assert.equal(result.error.details.recovery.registration.prunable.present, false);
    assert.equal(result.error.details.recovery.exactRemovalCandidate, false);
  } finally {
    if (registration(repo.root, workspace)) {
      try { git(repo.root, ['worktree', 'unlock', workspace]); } catch {}
      removeRegistration(repo.root, workspace);
    }
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 replaced workspace paths are no-follow and never recovery eligible', { skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false }, () => {
  const repo = makeRepository();
  const parent = temp('i69-replaced-');
  const target = temp('i69-replaced-target-');
  const runRoot = path.join(parent, 'run-root');
  const workspace = path.join(runRoot, 'workspace');
  const originalMkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = (file, options) => {
      const result = originalMkdir(file, options);
      if (pathKey(file) === pathKey(runRoot)) fs.symlinkSync(target, workspace, 'dir');
      return result;
    };
    const created = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(created.ok, false);
    assert.equal(created.error.code, 'workspace_path_occupied');
    assert.equal(created.error.details.recovery.classification, 'path_occupied');
    assert.equal(created.error.details.recovery.pathKind, 'symlink');
    assert.equal(created.error.details.recovery.followed, false);
    assert.equal(created.error.details.recovery.exactRemovalCandidate, false);
    assert.equal(registration(repo.root, workspace), undefined);

    fs.mkdirSync = originalMkdir;
    const physicalParent = path.join(parent, 'physical-parent');
    const aliasParent = path.join(parent, 'alias-parent');
    originalMkdir(physicalParent);
    fs.symlinkSync(physicalParent, aliasParent, 'dir');
    const ancestor = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot: path.join(aliasParent, 'run-root'), allowCloneFallback: false });
    assert.equal(ancestor.ok, false);
    assert.equal(ancestor.error.code, 'workspace_failed');
    assert.match(ancestor.error.message, /symlink path component rejected/);
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 receipt failure reports partial creation without automatic cleanup', () => {
  const repo = makeRepository();
  const parent = temp('i69-partial-');
  const runRoot = path.join(parent, 'run-root');
  const workspace = path.join(runRoot, 'workspace');
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, data, options) => {
      if (path.basename(file) === '.cleanup-receipt.json') {
        const error = new Error('injected receipt failure'); error.code = 'EACCES'; throw error;
      }
      return originalWrite(file, data, options);
    };
    const result = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'partial_creation');
    assert.equal(result.error.phase, 'workspace_create');
    assert.equal(result.error.details.recovery.classification, 'path_occupied');
    assert.equal(result.error.details.recovery.pathKind, 'directory');
    assert.equal(result.error.details.recovery.receiptPresent, false);
    assert.equal(result.error.details.recovery.validRunOwnedReceipt, false);
    assert.equal(result.error.details.recovery.exactRemovalCandidate, false);
    assert.ok(fs.existsSync(workspace), 'failed helper must not clean the partial path');
    assert.ok(registration(repo.root, workspace), 'failed helper must not remove the partial registration');
    assert.equal(fs.existsSync(path.join(runRoot, '.cleanup-receipt.json')), false);
  } finally {
    fs.writeFileSync = originalWrite;
    removeRegistration(repo.root, workspace);
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #69 missing path without registration is not classified as stale and default roots are unique', async () => {
  const repo = makeRepository();
  const explicitParent = temp('i69-no-registration-');
  const explicitRoot = path.join(explicitParent, 'new-root');
  const failedRoot = path.join(explicitParent, 'failed-root');
  const failedWorkspace = path.join(failedRoot, 'workspace');
  const missingHead = 'f'.repeat(40);
  const created = [];
  try {
    const before = helpers.parseWorktrees(repo.root);
    const failed = helpers.createWorkspace({ cwd: repo.root, head: missingHead, tree: repo.tree, runRoot: failedRoot, allowCloneFallback: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'linked_unavailable');
    assert.equal(failed.error.phase, 'workspace_create');
    const evidence = failed.error.details.recovery;
    assert.equal(evidence.classification, 'missing_path_without_registration');
    assert.equal(samePathIdentity(evidence.repository, repo.root), true);
    assert.equal(samePathIdentity(evidence.commonGitDir, path.join(repo.root, '.git')), true);
    assert.equal(pathKey(evidence.workspacePath), pathKey(failedWorkspace));
    assert.equal(evidence.expectedHead, missingHead);
    assert.equal(evidence.pathKind, 'absent');
    assert.equal(evidence.followed, false);
    assert.equal(evidence.registration, null);
    assert.equal(evidence.receiptPresent, false);
    assert.equal(evidence.validRunOwnedReceipt, false);
    assert.equal(evidence.runRootSource, 'explicit');
    assert.equal(evidence.exactRemovalCandidate, false);
    assert.equal(fs.existsSync(failedWorkspace), false);
    assert.deepEqual(helpers.parseWorktrees(repo.root), before, 'failed creation must not change registrations');

    const explicit = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot: explicitRoot, allowCloneFallback: false });
    assert.equal(explicit.ok, true, JSON.stringify(explicit));
    created.push(explicit);
    const first = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, allowCloneFallback: false });
    const second = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, allowCloneFallback: false });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    created.push(first, second);
    assert.notEqual(pathKey(first.data.root), pathKey(second.data.root));
    assert.notEqual(pathKey(first.data.path), pathKey(second.data.path));
  } finally {
    for (const item of created.reverse()) {
      const cleaned = await helpers.cleanupWorkspace(item.data.receipt, repo.root);
      assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    }
    fs.rmSync(explicitParent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

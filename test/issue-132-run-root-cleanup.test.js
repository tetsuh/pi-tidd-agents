'use strict';

// Issue #132. `workspace_create` allocates a run root under the temporary parent and builds the linked worktree
// inside it; `workspace_cleanup` removes that worktree and unlinks the receipt, and nothing removed the root. They
// accumulate without bound — this machine held 1,127 when the issue was filed, and one `npm test` of the merged
// base leaves twelve more. The root is removed by the cleanup that empties it, and by nothing else: a cleanup that
// refuses removes nothing, and a root holding anything the run did not put there is kept, not destroyed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { repoPath, readText } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A repository with an origin, because a linked workspace's stored identity states its fetch and push remotes.
function fixtureRepository() {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = temp('issue-132-repo-'); const bare = temp('issue-132-origin-');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 132 Test']); git(root, ['config', 'user.email', 'issue132@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
  git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
  git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

// The invocation gets a temporary parent of its own. While this was RED the run root survived, and a test about an
// unbounded accumulation must not add to it.
function cli(operation, data, parent) {
  const run = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation, data }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
  });
  return JSON.parse(run.stdout);
}

function createWorkspace(repository, parent) {
  const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree }, parent);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  // The root the operation reports is the only one in scope. Nothing here scans the parent for a prefix, so a root
  // any other run owns is never a candidate for removal or for an assertion (Issue #133).
  assert.equal(path.dirname(created.data.root), fs.realpathSync(parent), 'the run root sits in this invocation\'s own parent');
  assert.deepEqual(fs.readdirSync(created.data.root).sort(), ['.cleanup-receipt.json', 'workspace'], 'the root holds the workspace and the receipt');
  return created;
}

function withFixture(run) {
  const repository = fixtureRepository();
  const parent = temp('issue-132-parent-');
  try {
    run(repository, parent);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
}

test('Issue #132 a successful cleanup leaves no run root behind', () => {
  withFixture((repository, parent) => {
    const created = createWorkspace(repository, parent);
    const cleaned = cli('workspace_cleanup', { cwd: repository.root, receipt: created.data.receipt }, parent);
    // Asserted first: a cleanup that refused would leave the workspace behind too, so an absence asserted before
    // the operation is known to have removed anything would be about a removal that never ran.
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(fs.existsSync(created.data.path), false, 'the linked worktree is gone');
    assert.equal(fs.existsSync(created.data.root), false, 'the run root the operation emptied is gone');
    assert.equal(cleaned.data.retainedRoot, null, 'nothing was left to name');
  });
});

test('Issue #132 a refused cleanup removes nothing, the run root included', () => {
  withFixture((repository, parent) => {
    const created = createWorkspace(repository, parent);
    const refused = cli('workspace_cleanup', { cwd: repository.root, workspace: repository.root }, parent);
    assert.equal(refused.ok, false, JSON.stringify(refused.data));
    // The code, not only the phase: every error this operation returns carries the phase, so a phase alone would
    // be satisfied by a refusal for any reason at all.
    assert.equal(refused.error.code, 'cleanup_not_authorized', JSON.stringify(refused.error));
    assert.equal(fs.existsSync(created.data.path), true, 'the workspace a refused cleanup never named still stands');
    assert.deepEqual(fs.readdirSync(created.data.root).sort(), ['.cleanup-receipt.json', 'workspace'], 'the run root is untouched by a refusal');
  });
});

test('Issue #132 a receipt planted in another directory cannot aim the removal at it', () => {
  withFixture((repository, parent) => {
    const created = createWorkspace(repository, parent);
    // A copy of a valid receipt, in a directory this package never created, handed back as the run root. Every
    // identity the stored file states still matches, because it is the same file; what does not match is the one
    // thing the receipt-carrying way in never checked — that the workspace it describes lives in that root.
    const planted = fs.mkdtempSync(path.join(parent, 'unrelated-'));
    fs.copyFileSync(path.join(created.data.root, '.cleanup-receipt.json'), path.join(planted, '.cleanup-receipt.json'));
    const receipt = { ...created.data.receipt, root: planted, storedPath: path.join(planted, '.cleanup-receipt.json') };
    const refused = cli('workspace_cleanup', { cwd: repository.root, receipt }, parent);
    assert.equal(refused.ok, false, JSON.stringify(refused.data));
    assert.equal(refused.error.code, 'workspace_mismatch', JSON.stringify(refused.error));
    assert.equal(fs.existsSync(planted), true, 'the directory the package never created still stands');
    assert.equal(fs.existsSync(created.data.path), true, 'the real workspace still stands');
    assert.deepEqual(fs.readdirSync(created.data.root).sort(), ['.cleanup-receipt.json', 'workspace'], 'the real run root still stands');
  });
});

const rootSkip = process.platform === 'win32'
  ? 'directory permissions do not refuse removal on Windows'
  : (process.getuid?.() === 0 ? 'root bypasses the permission bit this case relies on' : false);

// A run root whose parent refuses the removal. The root gets a container of its own so the packaged process keeps a
// writable temporary parent for its own isolation root, and only the removal is refused.
function unremovableRoot(repository, parent, fill) {
  const container = fs.mkdtempSync(path.join(parent, 'container-'));
  const runRoot = path.join(container, 'root');
  const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree, runRoot }, parent);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  if (fill) fs.writeFileSync(path.join(created.data.root, fill), 'unexpected' + String.fromCharCode(10));
  fs.chmodSync(container, 0o500);
  let cleaned;
  try { cleaned = cli('workspace_cleanup', { cwd: repository.root, receipt: created.data.receipt }, parent); }
  finally { fs.chmodSync(container, 0o700); }
  return { created, cleaned };
}

test('Issue #132 a root the cleanup emptied but could not remove is named, not claimed removed', { skip: rootSkip }, () => {
  withFixture((repository, parent) => {
    const { created, cleaned } = unremovableRoot(repository, parent, null);
    // The work the operation was asked to do is done, so it succeeds (CL-D75): a cleanup whose worktree and receipt
    // are gone must not become a dead run over a leftover it cannot remove and cannot retry, since the receipt it
    // would need to re-authorize with is already unlinked.
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(fs.existsSync(created.data.path), false, 'the linked worktree is gone');
    assert.deepEqual(fs.readdirSync(created.data.root), [], 'the root was emptied');
    // And it says so, rather than reporting an outcome that did not happen (ADV-134-SILENT-RMDIR-FAILURE).
    assert.equal(cleaned.data.retainedRoot, created.data.root, JSON.stringify(cleaned.data));
  });
});

test('Issue #132 a non-empty root refused by its parent is the same success, named the same way', { skip: rootSkip }, () => {
  withFixture((repository, parent) => {
    // The same filesystem state as the case below, refused for a different reason: an unwritable parent answers
    // EACCES where a non-empty directory answers ENOTEMPTY. Reading the outcome from the errno made one of these
    // succeed and the other fail, so the result is observed instead.
    const { created, cleaned } = unremovableRoot(repository, parent, 'run.log');
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(cleaned.data.retainedRoot, created.data.root, JSON.stringify(cleaned.data));
    assert.deepEqual(fs.readdirSync(created.data.root), ['run.log'], 'what the root still held is kept');
  });
});

test('Issue #132 a run root holding anything else is kept, not emptied', () => {
  withFixture((repository, parent) => {
    const created = createWorkspace(repository, parent);
    // The removal is not recursive, so content the run did not put in the root survives — and the operation still
    // succeeds, because the workspace and the receipt are what it was asked to remove.
    fs.writeFileSync(path.join(created.data.root, 'run.log'), 'unexpected' + String.fromCharCode(10));
    const cleaned = cli('workspace_cleanup', { cwd: repository.root, receipt: created.data.receipt }, parent);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(fs.existsSync(created.data.path), false, 'the linked worktree is gone');
    assert.deepEqual(fs.readdirSync(created.data.root), ['run.log'], 'the root and what it still held are kept');
    assert.equal(cleaned.data.retainedRoot, created.data.root, JSON.stringify(cleaned.data));
  });
});

test('Issue #132 the leftover is observed, not inferred from the refusal (CL-D75)', () => {
  // A flag set in the catch is observationally identical to this in every state a test can build, differing only
  // under a race, so CL-D75's distinguishing claim has no black-box witness and is pinned structurally instead.
  const source = readText('skills/closed-loop-pr/helpers/workspace.js');
  assert.match(source, /const retainedRoot = fs\.existsSync\(rootPath\) \? rootPath : null;/);
});

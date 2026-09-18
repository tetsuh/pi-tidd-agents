'use strict';

// Issue #142. An exact-autofix run on PR #139 built its terminal cleanup with `build_workspace_cleanup` and handed it
// the workspace being removed as the cwd; the builder refused, correctly, and the run ended BLOCKED with the workspace
// retained. The cwd was never the caller's to choose: the receipt already states the repository the workspace was
// created from, so the builder takes it from there and no longer accepts one (owner choice,
// issues/142#issuecomment-5733269978, recorded as CL-D76).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { repoPath } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fixtureRepository() {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = temp('issue-142-repo-'); const bare = temp('issue-142-origin-');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 142 Test']); git(root, ['config', 'user.email', 'issue142@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
  git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
  git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

// Each invocation gets a temporary parent of its own, so a workspace this file fails to remove never joins the
// accumulation Issue #132 is about.
function cli(operation, data, parent) {
  const run = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation, data }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
  });
  return JSON.parse(run.stdout);
}

function withWorkspace(run) {
  const repository = fixtureRepository();
  const parent = temp('issue-142-parent-');
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree }, parent);
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.equal(created.data.kind, 'linked', JSON.stringify(created.data));
    run(repository, parent, created.data);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
}

test('Issue #142 the cleanup builder takes the repository from the receipt, and the request it builds removes the workspace', () => {
  withWorkspace((repository, parent, created) => {
    const built = cli('build_workspace_cleanup', { created }, parent);
    assert.equal(built.ok, true, JSON.stringify(built.error));
    const request = built.data.request;
    assert.equal(request.operation, 'workspace_cleanup');
    // The value the operation holds against the stored receipt, not the unchecked copy beside it.
    assert.equal(request.data.cwd, created.receipt.creationIdentity.repositoryCwd);
    assert.equal(fs.realpathSync(request.data.cwd), fs.realpathSync(repository.root), 'the repository the workspace was created from');
    // The built request is run, so what is asserted below is what the removal did, not what a request looked like.
    const cleaned = cli(request.operation, request.data, parent);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(fs.existsSync(created.path), false, 'the workspace is gone');
  });
});

test('Issue #142 the cleanup builder accepts no cwd, the workspace included', () => {
  withWorkspace((repository, parent, created) => {
    // The PR #139 request, and a correct one: neither is the caller's to state any more.
    for (const cwd of [created.path, repository.root]) {
      const built = cli('build_workspace_cleanup', { created, cwd }, parent);
      assert.equal(built.ok, false, JSON.stringify(built.data));
      assert.equal(built.error.code, 'invalid_request', JSON.stringify(built.error));
      assert.equal(built.error.message, 'unknown request field: cwd', JSON.stringify(built.error));
    }
    assert.equal(fs.existsSync(created.path), true, 'a refused build removes nothing');
  });
});

test('Issue #142 a receipt whose repository is the workspace is still refused before any request exists', () => {
  withWorkspace((repository, parent, created) => {
    // The shared predicate still runs on the derived cwd (CL-D68), so an altered receipt cannot aim Git at the
    // workspace it is removing.
    const receipt = { ...created.receipt, creationIdentity: { ...created.receipt.creationIdentity, repositoryCwd: created.path } };
    const built = cli('build_workspace_cleanup', { created: { ...created, receipt } }, parent);
    assert.equal(built.ok, false, JSON.stringify(built.data));
    assert.equal(built.error.code, 'cleanup_cwd_inside_workspace', JSON.stringify(built.error));
    assert.equal(built.error.phase, 'build');
    const stated = cli('build_workspace_cleanup', { created: { ...created, receipt: { ...created.receipt, creationIdentity: { ...created.receipt.creationIdentity, repositoryCwd: undefined } } } }, parent);
    assert.equal(stated.ok, false, JSON.stringify(stated.data));
    assert.equal(stated.error.code, 'invalid_request', JSON.stringify(stated.error));
    assert.equal(fs.existsSync(created.path), true, 'nothing was removed');
  });
});

test('Issue #142 the unchecked copy beside the stored identity does not choose the cwd', () => {
  withWorkspace((repository, parent, created) => {
    // The receipt carries the repository twice; workspace_cleanup compares only the one inside the creation identity
    // with the stored file, so that one is what the builder reads. Altering the other changes nothing.
    const built = cli('build_workspace_cleanup', { created: { ...created, receipt: { ...created.receipt, repositoryCwd: created.path } } }, parent);
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.equal(built.data.request.data.cwd, created.receipt.creationIdentity.repositoryCwd);
  });
});

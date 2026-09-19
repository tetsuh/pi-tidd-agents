'use strict';

// Issue #143 (CL-D78). A workspace_create that fails after allocating its run root keeps the root, and the terminal
// report must name it; the error result carried no `root`, so a run stopped by the failure could not (owner choice,
// issues/143#issuecomment-5740766919). Every error returned after the root exists now names it as `details.root`.

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
  const root = temp('issue-143-repo-'); const bare = temp('issue-143-origin-');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 143 Test']); git(root, ['config', 'user.email', 'issue143@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
  git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
  git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

// Each invocation gets a temporary parent of its own, so the only run roots in it are the ones this case made.
function cli(operation, data, parent) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8', env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent } });
  return JSON.parse(run.stdout);
}

const roots = (parent) => fs.readdirSync(parent).filter((name) => name.startsWith('pi-autofix-helper-')).map((name) => fs.realpathSync(path.join(parent, name)));

function withFixture(run) {
  const repository = fixtureRepository();
  const parent = temp('issue-143-parent-');
  try { run(repository, parent); } finally {
    for (const dir of [parent, repository.root, repository.bare]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A head the repository does not have: `git worktree add` fails after the run root exists.
const MISSING_HEAD = '0'.repeat(40);

for (const [label, fallback, code] of [['without the clone fallback', false, 'linked_unavailable'], ['after the clone fallback also fails', true, 'clone_fallback_failed']]) {
  test(`Issue #143 a create that fails ${label} names the run root it kept`, () => {
    withFixture((repository, parent) => {
      const created = cli('workspace_create', { cwd: repository.root, head: MISSING_HEAD, tree: repository.tree, allowCloneFallback: fallback }, parent);
      assert.equal(created.ok, false, JSON.stringify(created.data));
      assert.equal(created.error.code, code, JSON.stringify(created.error));
      // The failure left exactly one root, and the result names that one.
      assert.deepEqual(roots(parent), [created.error.details?.root], JSON.stringify(created.error));
    });
  });
}

test('Issue #143 a failed create under an explicit run root names that root', () => {
  withFixture((repository, parent) => {
    const runRoot = path.join(parent, 'explicit-root');
    const created = cli('workspace_create', { cwd: repository.root, head: MISSING_HEAD, tree: repository.tree, allowCloneFallback: false, runRoot }, parent);
    assert.equal(created.ok, false, JSON.stringify(created.data));
    assert.equal(fs.existsSync(runRoot), true, 'the root survives the failure');
    assert.equal(created.error.details?.root, fs.realpathSync(runRoot), JSON.stringify(created.error));
  });
});

test('Issue #143 a create refused before any root exists names none', () => {
  withFixture((repository, parent) => {
    // An explicit run root that already exists is refused before anything is created.
    const runRoot = temp('issue-143-existing-');
    try {
      const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree, runRoot }, parent);
      assert.equal(created.ok, false, JSON.stringify(created.data));
      assert.equal(created.error.code, 'run_root_exists', JSON.stringify(created.error));
      assert.equal(created.error.details?.root, undefined, 'a root the operation did not create is not named as its own');
    } finally { fs.rmSync(runRoot, { recursive: true, force: true }); }
  });
});

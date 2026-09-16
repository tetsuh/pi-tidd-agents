'use strict';

// Issue #130. Every packaged process that spawns Git creates its own isolation root under the temporary parent and
// never removes it, so they accumulate without bound — this machine held 20,969 when the issue was filed. A process
// removes the root it created when it ends, on the failing path as well as the succeeding one, and removes no other.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const MESSAGE = `feat: s (#130)${String.fromCharCode(10)}`;

// A repository holding one commit, so the operation under test reaches a real Git spawn. An operation that refuses
// on request shape never builds the isolation root at all, and a test built on one proves nothing.
function fixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-130-repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  git('init', '-q', '-b', 'main', '.');
  const file = path.join(root, 'message.txt');
  fs.writeFileSync(file, Buffer.from(MESSAGE, 'utf8'));
  git('commit', '-q', '--allow-empty', '-F', file, '--cleanup=whitespace');
  return root;
}

// The invocation under test gets a temporary parent of its own, so a root any other process creates while this test
// runs can never be mistaken for its own. `os.tmpdir()` reads TMPDIR, which is what the helper's parent resolves to.
function invoke(data, parent) {
  return spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation: 'message_verify', data }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
  });
}
const rootsIn = (parent) => fs.readdirSync(parent).filter((entry) => entry.startsWith('pi-tidd-pr-helper-')).sort();

test('Issue #130 a packaged invocation leaves no isolation root behind', () => {
  const repository = fixtureRepository();
  try {
    for (const [name, expected, answered] of [
      ['the operation answers', MESSAGE, true],
      ['the operation refuses', `feat: other (#130)${String.fromCharCode(10)}`, false],
    ]) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-130-parent-'));
      try {
        const run = invoke({ cwd: repository, expected }, parent);
        const result = JSON.parse(run.stdout);
        // Asserted first: an invocation that never reached Git would leave no root for a reason that has nothing
        // to do with this issue, and the assertion below would pass without meaning anything.
        assert.equal(result.ok, answered, `${name}: ${run.stdout}${run.stderr}`);
        // `ok: false` alone is satisfied by a request-shape refusal, which never reaches the Git spawn that builds
        // the root; the refusal this case needs is the operation's own, after it read the commit object.
        assert.equal(result.error?.details?.subcheck ?? 'answered', answered ? 'answered' : 'message_bytes', `${name}: ${run.stdout}`);
        assert.deepEqual(rootsIn(parent), [], `${name}: the isolation root outlived the process`);
      } finally { fs.rmSync(parent, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(repository, { recursive: true, force: true }); }
});

test('Issue #130 a root another process owns is left alone', () => {
  const repository = fixtureRepository();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-130-parent-'));
  try {
    // A root indistinguishable from one of ours, created by something else and still in use.
    const foreign = fs.mkdtempSync(path.join(parent, 'pi-tidd-pr-helper-'));
    fs.writeFileSync(path.join(foreign, 'global.gitconfig'), '');
    const run = invoke({ cwd: repository, expected: MESSAGE }, parent);
    assert.equal(JSON.parse(run.stdout).ok, true, `${run.stdout}${run.stderr}`);
    assert.deepEqual(rootsIn(parent), [path.basename(foreign)], 'only the root this process did not create remains');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

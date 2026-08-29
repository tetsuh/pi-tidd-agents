'use strict';

// Issue #78 (CL-D46) — an embedded Git repository inside the checkout is emitted by
// `git ls-files --others` as a single entry with a trailing slash, in both the ignored and the
// untracked listings. The inventory normalizer rejected that entry's empty final component
// with `empty or dot path rejected`, so `operator_capture` failed preflight on any checkout
// carrying one — a vcpkg cache does (registries are git clones) — and the message blamed dots.
//
// TDD provenance: recorded with the focused command below at 0 passes and 3 failures. The two
// enumeration scenarios are behavioral RED against the rejecting normalizer; the strictness
// scenario is also RED at capture because it pins the new component-and-path message wording.
// That local output is not claimed as repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { normalizeCheckoutPath } = require('../skills/closed-loop-pr/helpers/paths');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function repository({ ignore } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-78-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 78 Test']);
  git(root, ['config', 'user.email', 'issue78@example.invalid']);
  if (ignore) fs.writeFileSync(path.join(root, '.gitignore'), ignore);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: base']);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-78-origin-'));
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  const nested = path.join(root, '.cache', 'vcpkg', 'registries', 'git-trees');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(nested, 'port.txt'), 'cached\n');
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']) };
}
function capture(root, head) {
  return helpers.captureOperatorCheckout({
    cwd: root,
    identity: {
      repository: 'owner/repo', prNumber: 78, lifecycle: 'OPEN',
      baseOid: 'a'.repeat(40), publicHead: head, headRepository: 'owner/repo',
      headBranch: 'main', originFetch: git(root, ['remote', 'get-url', 'origin']), originPush: git(root, ['remote', 'get-url', 'origin']),
    },
  });
}
function cleanup(repo) {
  fs.rmSync(repo.root, { recursive: true, force: true });
  fs.rmSync(repo.bare, { recursive: true, force: true });
}

test('Issue #78 an ignored embedded repository no longer fails operator_capture', () => {
  const repo = repository({ ignore: '.cache/\n' });
  try {
    // The raw git emission really is a single trailing-slash entry; if git ever stops doing
    // this, the fixture is no longer testing the reported class.
    const raw = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
      cwd: repo.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).split('\0').filter(Boolean);
    assert.deepEqual(raw, ['.cache/vcpkg/registries/git-trees/']);

    const captured = capture(repo.root, repo.head);
    assert.equal(captured.ok, true, JSON.stringify(captured.error ?? {}));
    const entry = captured.data.ignoredInventory.find((item) => item.path === '.cache/vcpkg/registries/git-trees');
    assert.ok(entry, JSON.stringify(captured.data.ignoredInventory));
    assert.equal(entry.kind, 'directory');
    assert.equal(entry.followed, false);
    assert.equal(captured.data.clean, true, 'an ignored embedded repository must not block cleanliness');
  } finally { cleanup(repo); }
});

test('Issue #78 an untracked embedded repository is captured and blocks as untracked, not as a crash', () => {
  const repo = repository();
  try {
    const captured = capture(repo.root, repo.head);
    assert.equal(captured.ok, true, JSON.stringify(captured.error ?? {}));
    assert.ok(captured.data.untrackedPaths.includes('.cache/vcpkg/registries/git-trees'));
    assert.ok(captured.data.unexpectedUntrackedPaths.includes('.cache/vcpkg/registries/git-trees'));
    assert.equal(captured.data.clean, false, 'an unexpected untracked path still blocks by policy');
  } finally { cleanup(repo); }
});

test('Issue #78 the normalizer stays strict and its messages name the component and the path', () => {
  // The trailing-separator allowance lives at the enumeration boundary only: the shared
  // normalizer still rejects, and now says which component class failed in which entry.
  assert.throws(() => normalizeCheckoutPath('x/y/', '/tmp'), /empty path component rejected: x\/y\//);
  assert.throws(() => normalizeCheckoutPath('./x', '/tmp'), /dot path component rejected: \.\/x/);
  assert.throws(() => normalizeCheckoutPath('x/./y', '/tmp'), /dot path component rejected/);
  assert.throws(() => normalizeCheckoutPath('x/../y', '/tmp'), /path escapes checkout/);
  assert.throws(() => normalizeCheckoutPath('x/y/', undefined), /empty path component rejected/);

  // Exactly one trailing separator is stripped, never a run: git emits at most one, and a
  // doubled separator from any other source must still fail closed downstream. The property
  // has no black-box witness — git cannot be made to emit `x//` — so it is pinned
  // structurally, the way the CL-D44 suite pins the cleanup signature.
  const source = fs.readFileSync(path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'operator.js'), 'utf8');
  assert.ok(source.includes("entry.endsWith('/') ? entry.slice(0, -1) : entry"), 'the strip must remove exactly one trailing separator');
});

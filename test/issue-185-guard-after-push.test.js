'use strict';

// Issue #185 — exact-autofix on PR #183 committed and pushed its first correction, and then stopped at the second
// batch's first guard: `guard_before_edit` compared the workspace against `workspace_create`'s head, while the
// workspace was one pushed commit ahead. `workspace_verify` accepts that fact through `transition`; the guard took no
// transition, so every batch after the first push was unreachable although CL-D79 allows five pushes per run.
//
// TDD provenance: behavioural RED — the guard refuses the pushed workspace and has no transition input before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { readText } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function cli(operation, data) {
  return JSON.parse(spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' }).stdout);
}
// A run-owned workspace whose HEAD is one committed correction ahead of the head it was created at: the state after
// the first push.
function pushedWorkspace() {
  const root = temp('i185-repo-');
  git(root, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'test: base']);
  const bare = temp('i185-origin-');
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'main']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const created = cli('workspace_create', { cwd: root, head, tree: git(root, ['rev-parse', 'HEAD^{tree}']) });
  assert.equal(created.ok, true, JSON.stringify(created));
  const workspace = created.data.path;
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'first correction\n');
  git(workspace, ['add', 'tracked.txt']);
  git(workspace, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fix: first correction']);
  return { created: created.data, head, pushed: git(workspace, ['rev-parse', 'HEAD']) };
}

test('Issue #185 the guard takes the post-push transition workspace_verify takes', () => {
  const { created, head, pushed } = pushedWorkspace();
  const request = { cwd: created.path, expected: created, authorizedPaths: ['tracked.txt'] };
  const without = cli('guard_before_edit', request);
  assert.deepEqual([without.ok, without.error?.code], [false, 'identity_mismatch'], 'without the transition the pushed workspace is refused');
  const verified = cli('workspace_verify', { cwd: created.path, expected: created, transition: { from: head, to: pushed } });
  assert.equal(verified.ok, true, `workspace_verify accepts the same fact: ${JSON.stringify(verified)}`);
  const withTransition = cli('guard_before_edit', { ...request, transition: { from: head, to: pushed } });
  assert.equal(withTransition.ok, true, JSON.stringify(withTransition));
});

test('Issue #185 a transition that does not describe the workspace is still refused', () => {
  const { created, head, pushed } = pushedWorkspace();
  const request = { cwd: created.path, expected: created, authorizedPaths: ['tracked.txt'] };
  for (const [label, transition] of [['wrong target', { from: head, to: 'c'.repeat(40) }], ['wrong origin', { from: 'd'.repeat(40), to: pushed }]]) {
    const result = cli('guard_before_edit', { ...request, transition });
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.error.phase, 'guard_before_edit', label);
    assert.notEqual(result.error.code, 'invalid_request', `${label}: refused by the identity check, not as an unknown input`);
  }
  const malformed = cli('guard_before_edit', { ...request, transition: { from: head, to: pushed, extra: true } });
  assert.deepEqual([malformed.ok, malformed.error?.code], [false, 'invalid_request']);
});

test('Issue #185 the map and the CLI table state the input', () => {
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /guard_before_edit: \{ required: \['cwd', 'expected', 'authorizedPaths'\], optional: \['transition'\] \}/);
  assert.match(readText('skills/closed-loop-pr/references/helper-map.md'), /\| `guard_before_edit` \| `cwd`, `expected` \(data of `workspace_create`\), `authorizedPaths`, and after a push the same `transition` `workspace_verify` takes \(#185\) \|/);
});

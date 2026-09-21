'use strict';

// Issue #161 (CL-D84). The terminal cleanup was the last request the parent assembled by hand: on PR #149's
// exact-autofix run of 2026-09-20 it wrote `{created, cwd}` itself, CL-D76 refused the `cwd` it added, the run kept a
// workspace root, and it drafted no publication artifacts. `workspace_cleanup_created` takes the run's own
// `workspace_create` result and nothing else: it composes the request inside the package and runs it, so there is no
// document for the parent to widen (owner choice A2, issues/161#issuecomment-5750547876).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath, cliSchemas } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cli(operation, data, env = {}) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run.stdout, /^\{"version":1,/, `the CLI did not answer: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// A repository with an origin, as `workspace_create` requires, and a private parent for the run root.
async function withCreatedWorkspace(run) {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = temp('issue-161-repo-'); const bare = temp('issue-161-origin-'); const parent = temp('issue-161-parent-');
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 161 Test']); git(root, ['config', 'user.email', 'issue161@example.invalid']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
    git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
    git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', '-q', 'origin', 'main']);
    const created = cli('workspace_create', { cwd: root, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) }, { TMPDIR: parent, TEMP: parent, TMP: parent });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    await run({ created: created.data, root, parent });
  } finally {
    for (const dir of [parent, root, bare]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Issue #161 the packaged terminal cleanup removes the workspace from the receipt alone', async () => {
  await withCreatedWorkspace(async ({ created }) => {
    assert.equal(fs.existsSync(created.path), true, 'the workspace exists before the cleanup');
    const cleaned = cli('workspace_cleanup_created', { created });
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true, JSON.stringify(cleaned.data));
    assert.equal(fs.existsSync(created.path), false, 'the workspace is gone');
    // The result is the one `workspace_cleanup` returns, whole: CL-D49 reads the terminal head and tree from it as
    // the run's terminal workspace evidence, and CL-D78 reads `retainedRoot` to report a root the run kept
    // (ADV161-RESULT-FIELDS-UNPINNED).
    assert.deepEqual(Object.keys(cleaned.data).sort(), ['id', 'path', 'removed', 'retainedRoot', 'terminalHead', 'terminalTree']);
    assert.deepEqual([cleaned.data.path, cleaned.data.terminalHead, cleaned.data.terminalTree, cleaned.data.id, cleaned.data.retainedRoot],
      [created.path, created.head, created.tree, created.receipt.id, null], JSON.stringify(cleaned.data));
  });
});

test('Issue #161 the parent supplies the created workspace and nothing else', async () => {
  await withCreatedWorkspace(async ({ created, root }) => {
    // The failure this closes: PR #149's run added a `cwd`, which CL-D76 refuses, and the run ended there.
    for (const [label, data] of [
      ['a cwd beside it', { created, cwd: root }],
      ['an unknown field', { created, receipt: created.receipt }],
      ['no workspace', {}],
    ]) {
      const refused = cli('workspace_cleanup_created', data);
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      assert.deepEqual([refused.error.code, refused.error.phase], ['invalid_request', 'cli'], label);
    }
    assert.deepEqual(cliSchemas().workspace_cleanup_created, ['created']);
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /workspace_cleanup_created: \{ required: \['created'\], optional: \[\] \}/);
    // Still removable afterwards: the refusals above did nothing.
    assert.equal(cli('workspace_cleanup_created', { created }).ok, true);
  });
});

test('Issue #161 a cwd beside the workspace is refused in process, not overridden', async () => {
  // CL-D76 refuses a caller `cwd` so a direct caller is told rather than overridden; the packaged step must not be
  // the one place where that field is silently swallowed (ADV161-SILENT-OVERRIDE).
  await withCreatedWorkspace(async ({ created, root }) => {
    for (const [label, extra] of [['a cwd', { cwd: root }], ['the workspace as cwd', { cwd: created.path }], ['anything else', { receipt: created.receipt }]]) {
      const refused = await helpers.cleanupCreatedWorkspace({ created, ...extra });
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      assert.deepEqual([refused.error.code, refused.error.phase], ['invalid_request', 'build'], label);
      assert.equal(fs.existsSync(created.path), true, `${label}: the workspace survives`);
    }
    // A request that is not an object at all is an envelope, not a throw, as the sibling operations answer.
    for (const bad of [undefined, null, 'workspace']) {
      const refused = await helpers.cleanupCreatedWorkspace(bad);
      assert.deepEqual([refused.ok, refused.error.code, refused.error.phase], [false, 'invalid_request', 'build'], JSON.stringify(bad));
    }
  });
});

test('Issue #161 a workspace that is not workspace_create data is refused by the declared shape', async () => {
  // The CL-D44 entry is the reason a hand-assembled document cannot reach the cleanup; every one of these is the
  // declared-shape refusal, and none of them removes anything (ADV161-SHAPE-REFUSAL-UNTESTED).
  await withCreatedWorkspace(async ({ created }) => {
    const envelope = { version: 1, ok: true, operation: 'workspace_create', data: created };
    for (const [label, value] of [
      ['an empty object', {}],
      ['the envelope instead of its data', envelope],
      ['the receipt instead of the data', created.receipt],
      ['data without its receipt', { ...created, receipt: undefined }],
      ['data whose kind was renamed', { ...created, kind: 'worktree' }],
    ]) {
      const refused = cli('workspace_cleanup_created', { created: value });
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      assert.deepEqual([refused.error.code, refused.error.phase], ['input_shape_mismatch', 'workspace_cleanup_created'], `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(fs.existsSync(created.path), true, `${label}: the workspace survives`);
    }
  });
});

test('Issue #161 a cleanup the identity rules refuse removes nothing, and names what it saw', async () => {
  // The refusals above are build-phase, before any removal code runs. This one reaches the cleanup itself: the
  // workspace's origin is moved, so the identity reverification fails where the removal would have happened
  // (ADV161-REFUSAL-ONE-LAYER-EARLY).
  await withCreatedWorkspace(async ({ created, root }) => {
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
    git(root, ['remote', 'set-url', 'origin', temp('issue-161-elsewhere-')]);
    const refused = cli('workspace_cleanup_created', { created });
    assert.equal(refused.ok, false, JSON.stringify(refused.data));
    assert.equal(refused.error.phase, 'workspace_cleanup', JSON.stringify(refused.error));
    assert.equal(refused.error.code, 'identity_mismatch', JSON.stringify(refused.error));
    assert.equal(fs.existsSync(created.path), true, 'the workspace survives a refused cleanup');
    assert.equal(fs.existsSync(created.receipt.storedPath), true, 'and so does its receipt');
  });
});

test('Issue #161 a workspace it must not remove is refused, with the boundary it belongs to', async () => {
  await withCreatedWorkspace(async ({ created }) => {
    const clone = { kind: 'clone', path: created.path, root: created.root, head: created.head, tree: created.tree, cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' };
    const refusedClone = cli('workspace_cleanup_created', { created: clone });
    assert.deepEqual([refusedClone.ok, refusedClone.error.code, refusedClone.error.phase], [false, 'invalid_request', 'build'], JSON.stringify(refusedClone.error));
    const handMade = cli('workspace_cleanup_created', { created: { ...created, receipt: { ...created.receipt, creationIdentity: undefined } } });
    assert.equal(handMade.ok, false, JSON.stringify(handMade.data));
    assert.equal(handMade.error.phase, 'build', JSON.stringify(handMade.error));
    assert.equal(fs.existsSync(created.path), true, 'a refused cleanup removes nothing');
  });
});

test('Issue #161 the map and the record name the packaged terminal cleanup', () => {
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.ok(map.includes('| Terminal cleanup of the run-owned linked workspace (CL-D84) | `workspace_cleanup_created` | `created` (data of `workspace_create`); the request is composed inside the package |'), 'the map declares the operation');
  const record = readText('CONTRACT.md');
  assert.ok(record.includes('## CL-D84 — The terminal cleanup is one packaged operation'), 'CL-D84 must exist');
});

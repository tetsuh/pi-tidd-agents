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
const helpers = require('../skills/closed-loop-pr/helpers');

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
    // The packaged helper refuses it too, rather than quietly preferring the receipt: a caller handing one in is
    // told, and a later change cannot start honouring it without failing here.
    const direct = helpers.buildWorkspaceCleanup({ created, cwd: repository.root });
    assert.equal(direct.ok, false, JSON.stringify(direct.data));
    assert.deepEqual([direct.error.code, direct.error.message, direct.error.phase], ['invalid_request', 'unknown request field: cwd', 'build']);
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
    // A receipt stating no repository, stating an empty one, or carrying no creation identity at all is refused as
    // such, by the builder: the code alone would also match the CLI's own schema refusals.
    const identity = created.receipt.creationIdentity;
    for (const [label, receiptState] of [
      ['absent', { ...created.receipt, creationIdentity: { ...identity, repositoryCwd: undefined } }],
      ['empty', { ...created.receipt, creationIdentity: { ...identity, repositoryCwd: '' } }],
      ['no identity', { ...created.receipt, creationIdentity: undefined }],
    ]) {
      const stated = cli('build_workspace_cleanup', { created: { ...created, receipt: receiptState } }, parent);
      assert.equal(stated.ok, false, `${label}: ${JSON.stringify(stated.data)}`);
      assert.deepEqual([stated.error.code, stated.error.message, stated.error.phase], ['invalid_request', 'the receipt states no repository to run the cleanup from', 'build'], label);
    }
    assert.equal(fs.existsSync(created.path), true, 'nothing was removed');
  });
});

test('Issue #142 a receipt string the filesystem cannot take is refused at build, never certified (ADV-144-INVALID-REPOSITORY-NUL, ADV-144-UNCHECKED-REQUEST-PATHS)', () => {
  withWorkspace((repository, parent, created) => {
    // Every string the receipt carries, found by walking a genuine one rather than listed, so a field added to the
    // stored identity later is covered without anyone remembering to add it here. No filesystem call accepts a NUL
    // byte, and a lone surrogate is written as U+FFFD, so a request carrying either could never do what it names.
    const strings = [];
    (function walk(value, trail) {
      if (typeof value === 'string') strings.push(trail);
      else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, [...trail, key]);
    })(created.receipt, []);
    for (const field of ['root', 'storedPath', 'repositoryCwd', 'creationIdentity.repositoryCwd', 'creationIdentity.path', 'creationIdentity.repository', 'creationIdentity.gitDir', 'creationIdentity.commonGitDir', 'creationIdentity.registered.worktree']) {
      assert.ok(strings.some((trail) => trail.join('.') === field), `the walk reaches ${field}`);
    }
    const variants = [String.fromCharCode(0), `${String.fromCharCode(0)}/elsewhere`, String.fromCharCode(0xd800), String.fromCharCode(0xdc00)];
    for (const trail of strings) {
      for (const bad of variants) {
        const receipt = structuredClone(created.receipt);
        let holder = receipt;
        for (const key of trail.slice(0, -1)) holder = holder[key];
        holder[trail[trail.length - 1]] += bad;
        const field = trail.join('.');
        const built = cli('build_workspace_cleanup', { created: { ...created, receipt } }, parent);
        const label = `${field} + ${JSON.stringify(bad)}`;
        assert.equal(built.ok, false, `${label}: ${JSON.stringify(built.data)}`);
        assert.deepEqual([built.error.code, built.error.message, built.error.phase], ['invalid_request', `the receipt's ${JSON.stringify(trail)} carries a NUL byte or a lone surrogate`, 'build'], label);
      }
    }
    assert.equal(fs.existsSync(created.path), true, 'nothing was removed');
  });
});

test('Issue #142 an absent or non-string receipt path is refused in the boundary vocabulary, not as a crash (ADV-144-RECEIPT-PATH-TYPE)', () => {
  withWorkspace((repository, parent, created) => {
    for (const field of ['root', 'storedPath']) {
      for (const value of [undefined, 5, null, {}]) {
        const receipt = { ...created.receipt, [field]: value };
        const built = cli('build_workspace_cleanup', { created: { ...created, receipt } }, parent);
        const label = `${field} = ${JSON.stringify(value)}`;
        assert.equal(built.ok, false, `${label}: ${JSON.stringify(built.data)}`);
        // The code base 79f4f90 returned for the same input, from the boundary's own receipt shape check.
        assert.deepEqual([built.error.code, built.error.phase], ['input_shape_mismatch', 'build'], `${label}: ${JSON.stringify(built.error)}`);
        assert.match(built.error.message, /receipt:workspace_create/, label);
      }
    }
  });
});

test('Issue #142 a stored identity field of the wrong type, or missing, is refused at build (pre-push pass on ab05722)', () => {
  withWorkspace((repository, parent, created) => {
    // Every key a genuine creation identity carries, taken from one rather than listed, each given a value of another
    // type and then removed: the builder certifies only the shape workspace_create writes, which workspace_cleanup
    // would otherwise refuse later as cleanup_not_authorized.
    const identity = created.receipt.creationIdentity;
    const keys = Object.keys(identity);
    for (const key of ['kind', 'path', 'repository', 'head', 'tree', 'detached', 'gitDir', 'commonGitDir', 'registered', 'originFetch', 'originPush', 'repositoryCwd']) assert.ok(keys.includes(key), `a genuine identity carries ${key}`);
    const wrong = (value) => (typeof value === 'string' ? 5 : 'wrong');
    const cases = [];
    for (const key of keys) {
      cases.push([`${key} of another type`, { ...identity, [key]: wrong(identity[key]) }]);
      const without = { ...identity }; delete without[key];
      cases.push([`${key} absent`, without]);
    }
    for (const key of Object.keys(identity.registered)) {
      cases.push([`registered.${key} of another type`, { ...identity, registered: { ...identity.registered, [key]: wrong(identity.registered[key]) } }]);
    }
    cases.push(['kind clone', { ...identity, kind: 'clone' }], ['registered null', { ...identity, registered: null }]);
    for (const [label, changed] of cases) {
      const built = cli('build_workspace_cleanup', { created: { ...created, receipt: { ...created.receipt, creationIdentity: changed } } }, parent);
      assert.equal(built.ok, false, `${label}: ${JSON.stringify(built.data)}`);
      assert.deepEqual([built.error.code, built.error.phase], ['invalid_request', 'build'], `${label}: ${JSON.stringify(built.error)}`);
    }
    for (const id of [null, 5, '']) {
      const built = cli('build_workspace_cleanup', { created: { ...created, receipt: { ...created.receipt, id } } }, parent);
      assert.deepEqual([built.ok, built.error?.code, built.error?.phase], [false, 'invalid_request', 'build'], `id ${JSON.stringify(id)}: ${JSON.stringify(built.error)}`);
    }
    assert.equal(fs.existsSync(created.path), true, 'nothing was removed');
  });
});

test('Issue #142 a receipt nested beyond any genuine one, or with an unusable key, is refused at build', () => {
  withWorkspace((repository, parent, created) => {
    // A genuine receipt nests three levels; a deep one used to end in a raw stack-overflow message.
    let deep = 'x'; for (let i = 0; i < 5000; i += 1) deep = [deep];
    const nested = cli('build_workspace_cleanup', { created: { ...created, receipt: { ...created.receipt, extra: deep } } }, parent);
    assert.deepEqual([nested.ok, nested.error?.code, nested.error?.phase], [false, 'invalid_request', 'build'], JSON.stringify(nested.error));
    assert.match(nested.error.message, /nests deeper than/);
    for (const key of [`k${String.fromCharCode(0)}`, `k${String.fromCharCode(0xd800)}`]) {
      const receipt = { ...created.receipt, creationIdentity: { ...created.receipt.creationIdentity, [key]: 'x' } };
      const built = cli('build_workspace_cleanup', { created: { ...created, receipt } }, parent);
      assert.deepEqual([built.ok, built.error?.code, built.error?.phase], [false, 'invalid_request', 'build'], `${JSON.stringify(key)}: ${JSON.stringify(built.error)}`);
    }
  });
});

test('Issue #142 the cwd is judged against the workspace the receipt states, the one the operation compares', () => {
  withWorkspace((repository, parent, created) => {
    // `created.path` is never copied into the request; the operation compares the cwd with the stored creation
    // identity's path. A result whose top-level path disagrees must neither block a working request nor excuse one.
    const moved = cli('build_workspace_cleanup', { created: { ...created, path: repository.root } }, parent);
    assert.equal(moved.ok, true, JSON.stringify(moved.error));
    const inside = { ...created.receipt, creationIdentity: { ...created.receipt.creationIdentity, path: created.receipt.creationIdentity.repositoryCwd } };
    const refused = cli('build_workspace_cleanup', { created: { ...created, path: '/', receipt: inside } }, parent);
    assert.equal(refused.ok, false, JSON.stringify(refused.data));
    assert.deepEqual([refused.error.code, refused.error.phase], ['cleanup_cwd_inside_workspace', 'build']);
    // A stored identity naming no workspace leaves nothing to judge the cwd against, and is refused as such.
    for (const path of [undefined, '']) {
      const unnamed = { ...created.receipt, creationIdentity: { ...created.receipt.creationIdentity, path } };
      const built = cli('build_workspace_cleanup', { created: { ...created, receipt: unnamed } }, parent);
      assert.deepEqual([built.ok, built.error?.code, built.error?.message, built.error?.phase], [false, 'invalid_request', 'the receipt states no workspace to remove', 'build'], JSON.stringify(path));
    }
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

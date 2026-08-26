'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const protocol = require('../skills/closed-loop-pr/helpers/protocol');
const paths = require('../skills/closed-loop-pr/helpers/paths');
const processHelper = require('../skills/closed-loop-pr/helpers/process');
const fingerprints = require('../skills/closed-loop-pr/helpers/fingerprints');
const writability = require('../skills/closed-loop-pr/helpers/writability');
const snapshot = require('../skills/closed-loop-pr/helpers/snapshot');

const helperCli = path.resolve('skills/closed-loop-pr/helpers/cli.js');
const oid = (character) => character.repeat(40);
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function samePathIdentity(left, right) {
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}
function sameDirectoryEntry(left, right) {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  const namesMatch = process.platform === 'win32' ? leftName.toLowerCase() === rightName.toLowerCase() : leftName === rightName;
  return namesMatch && samePathIdentity(path.dirname(left), path.dirname(right));
}
function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function makeRepository() {
  const root = temp('i47-repo-');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 47 Test']);
  git(root, ['config', 'user.email', 'issue47@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'test: base']);
  const bare = temp('i47-origin-');
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}
function identityFor(repo) {
  return { repository: 'owner/repo', prNumber: 47, lifecycle: 'OPEN', baseOid: oid('a'), publicHead: repo.head, headRepository: 'owner/repo', headBranch: 'main', originFetch: repo.bare, originPush: repo.bare };
}
function noFollowTopLevelInventory(root) {
  return fs.readdirSync(root).sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).map((name) => {
    const stat = fs.lstatSync(path.join(root, name));
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    return { name, kind };
  });
}
function cli(request) {
  return spawnSync(process.execPath, [helperCli], { input: JSON.stringify(request), encoding: 'utf8' });
}

test('Issue #47 protocol and CLI use one strict v1 document and nonzero error exits', () => {
  assert.deepEqual(protocol.createResult('operator', { clean: true }), { version: 1, ok: true, operation: 'operator', data: { clean: true } });
  assert.throws(() => protocol.createResult('x', null), /plain object/);
  for (const request of [
    {},
    { version: 2, operation: 'writability', data: {} },
    { version: 1, operation: 'unknown', data: {} },
    { version: 1, operation: 'writability', data: { owner: 'o', repo: 'r', branchRef: 'refs/heads/main', extra: true } },
    { version: 1, operation: 'fingerprint_pr_head', data: { oid: oid('a') }, extra: true },
    { version: 1, operation: 'workspace_verify', data: { cwd: '.', expected: { path: '.' }, transition: { from: oid('a'), to: oid('b'), extra: true } } },
  ]) {
    const result = cli(request);
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 1);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, 'invalid_request');
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  }
});

test('Issue #47 path normalization is checkout-relative and fail-closed across platforms', () => {
  assert.equal(paths.normalizeCheckoutPath('C:\\work\\repo\\src\\x.js', 'C:\\work\\repo'), 'src/x.js');
  assert.equal(paths.normalizeCheckoutPath('/work/repo/src/x.js', '/work/repo'), 'src/x.js');
  assert.equal(paths.normalizeCheckoutPath('space ü/file.txt'), 'space ü/file.txt');
  for (const candidate of ['../outside', '.', '', '/outside/file', '\\\\server\\share\\x']) assert.throws(() => paths.normalizeCheckoutPath(candidate, '/work/repo'));
  assert.throws(() => paths.normalizeCheckoutPath('D:\\outside\\x', 'C:\\repo'), /cross-drive|outside/);
});

test('Issue #47 runtime roots are classified independently without following links', { skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false }, () => {
  const root = temp('i47-roots-');
  const target = temp('i47-target-');
  try {
    fs.mkdirSync(path.join(root, '.pi'));
    fs.symlinkSync(target, path.join(root, '.pi-subagents'));
    const result = paths.classifyRuntimeRoots(root);
    assert.deepEqual(result['.pi'], { kind: 'directory', followed: false, safe: true });
    assert.deepEqual(result['.pi-subagents'], { kind: 'symlink', followed: false, safe: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});

test('Issue #47 operator collector captures independent dimensions and revalidation', () => {
  const repo = makeRepository();
  try {
    const wrongIdentity = helpers.captureOperatorCheckout({ cwd: repo.root, identity: { ...identityFor(repo), publicHead: oid('f') } });
    assert.equal(wrongIdentity.ok, false);
    assert.equal(wrongIdentity.error.code, 'target_identity_mismatch');
    const captured = helpers.captureOperatorCheckout({ cwd: path.join(repo.root, '.'), identity: identityFor(repo) });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    const capturedRoot = fs.statSync(captured.data.root);
    const expectedRoot = fs.statSync(repo.root);
    assert.equal(capturedRoot.dev, expectedRoot.dev);
    assert.equal(capturedRoot.ino, expectedRoot.ino);
    assert.equal(captured.data.clean, true);
    assert.equal(captured.data.originPush, repo.bare);
    assert.match(captured.data.configDigest, /^[0-9a-f]{64}$/);
    const operatorConfig = spawnSync('git', ['config', '--local', '--get-all', 'operator.teststate'], {
      cwd: repo.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.equal(operatorConfig.status, 1);
    assert.equal(operatorConfig.stdout, '');
    git(repo.root, ['config', '--local', 'operator.teststate', 'changed']);
    const configChanged = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(configChanged.ok, false);
    assert.equal(configChanged.error.code, 'operator_changed');
    git(repo.root, ['config', '--local', '--unset-all', 'operator.teststate']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, true);
    fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'changed\n');
    const changed = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
    fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'base\n');
    const portableUnexpected = 'unexpected-name';
    fs.writeFileSync(path.join(repo.root, portableUnexpected), 'x');
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(repo.root, 'unexpected\nname'), 'x');
      fs.writeFileSync(path.join(repo.root, '.pi\\evil'), 'x');
    }
    const dirty = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(dirty.ok, true);
    assert.equal(dirty.data.clean, false);
    assert.ok(dirty.data.unexpectedUntrackedPaths.includes(portableUnexpected));
    if (process.platform !== 'win32') {
      assert.ok(dirty.data.unexpectedUntrackedPaths.includes('unexpected\nname'));
      assert.ok(dirty.data.unexpectedUntrackedPaths.includes('.pi\\evil'));
    }
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator captures ignored inventory and fails on unstable inventory', () => {
  const repo = makeRepository();
  try {
    fs.writeFileSync(path.join(repo.root, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(repo.root, 'ignored.txt'), 'ignored\n');
    const captured = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.ok(captured.data.ignoredInventory.some(({ path: entry }) => entry === 'ignored.txt'));
    const unstable = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo), inventoryFn: () => { throw Object.assign(new Error('unstable'), { code: 'inventory_unstable' }); } });
    assert.equal(unstable.ok, false);
    assert.equal(unstable.error.code, 'inventory_unstable');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator revalidation allows safe runtime churn but preserves immutable boundaries', { skip: process.platform === 'win32' ? 'symlink creation is privilege-dependent on Windows' : false }, () => {
  const repo = makeRepository();
  const inventory = (root) => ({
    untrackedPaths: fs.existsSync(path.join(root, '.pi')) ? ['.pi/runtime-state'] : [],
    ignoredInventory: [],
    runtimeInventory: fs.existsSync(path.join(root, '.pi')) ? [{ path: '.pi/runtime-state', kind: 'file', followed: false }] : [],
  });
  try {
    const captured = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo), inventoryFn: inventory });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    fs.mkdirSync(path.join(repo.root, '.pi'));
    fs.writeFileSync(path.join(repo.root, '.pi', 'runtime-state'), 'safe churn\n');
    const churn = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, inventoryFn: inventory });
    assert.equal(churn.ok, true, JSON.stringify(churn));
    fs.rmSync(path.join(repo.root, '.pi'), { recursive: true, force: true });
    const absent = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, inventoryFn: inventory });
    assert.equal(absent.ok, true, JSON.stringify(absent));
    fs.writeFileSync(path.join(repo.root, '.pi'), 'unsafe root\n');
    const unsafeFile = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, inventoryFn: inventory });
    assert.equal(unsafeFile.ok, false);
    assert.equal(unsafeFile.error.code, 'unsafe_runtime_root');
    fs.rmSync(path.join(repo.root, '.pi'));
    fs.symlinkSync(repo.bare, path.join(repo.root, '.pi'));
    const unsafeSymlink = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, inventoryFn: inventory });
    assert.equal(unsafeSymlink.ok, false);
    assert.equal(unsafeSymlink.error.code, 'unsafe_runtime_root');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator revalidation rejects non-runtime, ignored, config, and tracking drift', () => {
  const repo = makeRepository();
  try {
    const capture = () => helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    fs.writeFileSync(path.join(repo.root, 'outside.txt'), 'unexpected\n');
    let captured = capture();
    assert.equal(captured.ok, true, JSON.stringify(captured));
    fs.writeFileSync(path.join(repo.root, 'outside-2.txt'), 'unexpected\n');
    let changed = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
    fs.rmSync(path.join(repo.root, 'outside-2.txt'));
    fs.rmSync(path.join(repo.root, 'outside.txt'));

    fs.writeFileSync(path.join(repo.root, '.git', 'info', 'exclude'), 'ignored-a\nignored-b\n');
    fs.writeFileSync(path.join(repo.root, 'ignored-a'), 'a\n');
    captured = capture();
    assert.equal(captured.ok, true, JSON.stringify(captured));
    fs.writeFileSync(path.join(repo.root, 'ignored-b'), 'b\n');
    changed = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
    fs.rmSync(path.join(repo.root, 'ignored-a'));
    fs.rmSync(path.join(repo.root, 'ignored-b'));
    fs.writeFileSync(path.join(repo.root, '.git', 'info', 'exclude'), '');

    captured = capture();
    const commitEnv = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const commitTree = (args, message) => execFileSync('git', ['commit-tree', ...args], {
      cwd: repo.root, encoding: 'utf8', input: message,
      env: { ...process.env, ...commitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    const alternate = git(repo.root, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD'], commitEnv);
    git(repo.root, ['update-ref', 'refs/remotes/origin/main', alternate]);
    changed = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');

    const postPush = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: alternate });
    assert.equal(postPush.ok, true, JSON.stringify(postPush));
    const routed = cli({ version: 1, operation: 'operator_revalidate', data: { captured, cwd: repo.root, postPushHead: alternate } });
    assert.equal(routed.status, 1, routed.stderr || routed.stdout);
    const routedResult = JSON.parse(routed.stdout);
    assert.equal(routedResult.ok, false);
    assert.equal(routedResult.error.code, 'input_shape_mismatch');
    // The direct helper API above remains the compatibility surface; only packaged composition
    // rejects its legacy operator_checkout envelope before dispatch.

    const spoofedRoot = commitTree(['HEAD^{tree}'], `parent ${repo.head}\n`);
    git(repo.root, ['update-ref', 'refs/remotes/origin/main', spoofedRoot]);
    changed = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: spoofedRoot });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');

    const childWithSpoofedMessage = commitTree(['HEAD^{tree}', '-p', 'HEAD'], `parent ${repo.head}\n`);
    git(repo.root, ['update-ref', 'refs/remotes/origin/main', childWithSpoofedMessage]);
    const messageSafe = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: childWithSpoofedMessage });
    assert.equal(messageSafe.ok, true, JSON.stringify(messageSafe));

    const unrelated = git(repo.root, ['commit-tree', 'HEAD^{tree}'], commitEnv);
    git(repo.root, ['update-ref', 'refs/remotes/origin/main', unrelated]);
    changed = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: unrelated });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');

    const merge = git(repo.root, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', unrelated], commitEnv);
    git(repo.root, ['update-ref', 'refs/remotes/origin/main', merge]);
    changed = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: merge });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
    changed = helpers.revalidateOperatorCheckout(captured, { cwd: repo.root, postPushHead: alternate });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator collector rejects unsafe local Git execution configuration', () => {
  const repo = makeRepository();
  try {
    git(repo.root, ['config', 'filter.hostile.clean', 'echo hostile']);
    const result = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unsafe_git_config');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator baseline includes enabled worktree configuration', () => {
  const repo = makeRepository();
  try {
    git(repo.root, ['config', 'extensions.worktreeConfig', 'true']);
    git(repo.root, ['config', '--worktree', 'operator.state', 'one']);
    const captured = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    git(repo.root, ['config', '--worktree', 'operator.state', 'two']);
    const changed = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'operator_changed');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 process environment removes inherited Git execution controls', () => {
  const inherited = {
    GIT_CONFIG_COUNT: 'not-a-number',
    GIT_COMMON_DIR: '/unreviewed-common-git-dir',
    GIT_ALLOW_PROTOCOL: 'ext',
    GIT_SSH: 'unreviewed-ssh-helper',
    GIT_SSH_VARIANT: 'unreviewed-ssh-variant',
    GIT_PROXY_COMMAND: 'unreviewed-proxy-helper',
  };
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  try {
    for (const kind of ['git', 'gh']) {
      const env = processHelper.sanitizedEnv({}, kind);
      for (const key of Object.keys(inherited)) assert.equal(env[key], undefined, `${kind} preserved ${key}`);
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    }
    const env = processHelper.sanitizedEnv({}, 'git');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.notEqual(env.HOME, process.env.HOME);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Issue #47 sanitized Git execution ignores inherited common Git directory', () => {
  const repo = makeRepository();
  const alternate = temp('i47-common-dir-');
  fs.cpSync(path.join(repo.root, '.git'), alternate, { recursive: true });
  const previous = process.env.GIT_COMMON_DIR;
  try {
    const redirected = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repo.root, encoding: 'utf8', env: { ...process.env, GIT_COMMON_DIR: alternate, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    assert.equal(samePathIdentity(redirected, alternate), true, 'control must demonstrate GIT_COMMON_DIR redirection');
    process.env.GIT_COMMON_DIR = alternate;
    const actual = processHelper.runSync('git', processHelper.gitArgs(['rev-parse', '--path-format=absolute', '--git-common-dir']), {
      cwd: repo.root, phase: 'common_dir_regression',
    }).trim();
    assert.equal(samePathIdentity(actual, path.join(repo.root, '.git')), true);
  } finally {
    if (previous === undefined) delete process.env.GIT_COMMON_DIR; else process.env.GIT_COMMON_DIR = previous;
    fs.rmSync(alternate, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 sanitized Git execution cannot inherit permission to launch an ext transport', () => {
  const root = temp('i47-ext-transport-');
  const script = path.join(root, 'transport.js');
  const marker = path.join(root, 'executed.txt');
  const extToken = (value) => value.replaceAll('\\', '/').replaceAll('%', '%%').replaceAll(' ', '% ');
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], 'executed\\n');\n");
  const remote = `ext::${extToken(process.execPath)} ${extToken(script)} ${extToken(marker)}`;
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  try {
    spawnSync('git', processHelper.gitArgs(['ls-remote', remote]), {
      encoding: 'utf8',
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'ext', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.equal(fs.existsSync(marker), true, 'control must demonstrate that ext permission launches the transport');
    fs.rmSync(marker);

    process.env.GIT_ALLOW_PROTOCOL = 'ext';
    assert.throws(
      () => processHelper.runSync('git', processHelper.gitArgs(['ls-remote', remote]), { phase: 'ext_transport_regression' }),
      (error) => error.code === 'command_failed',
    );
    assert.equal(fs.existsSync(marker), false, 'sanitized execution must reject ext before launching the transport');
  } finally {
    if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #47 named CL-D9 fingerprints have deterministic byte formulas', () => {
  const comments = [
    { id: '9007199254740993', updated_at: 'u2', body: 'second\r\nline', author_association: 'MEMBER', user: { type: 'User' } },
    { id: '9', updated_at: 'u1', body: 'first', author_association: 'OWNER', user: { type: 'User' } },
    { id: '10', updated_at: 'u', body: 'bot', author_association: 'OWNER', user: { type: 'Bot' } },
    { id: '11', updated_at: 'u', body: 'outsider', author_association: 'NONE', user: { type: 'User' } },
  ];
  const issueBytes = Buffer.from('body\n9:u1:first\n9007199254740993:u2:second\nline');
  assert.equal(fingerprints.issueSpecFingerprint({ body: 'body', comments }), crypto.createHash('sha256').update(issueBytes).digest('hex'));
  assert.equal(fingerprints.prBaseFingerprint(oid('a')), oid('a'));
  assert.equal(fingerprints.prTreeFingerprint(oid('b')), oid('b'));
  assert.equal(fingerprints.prHeadFingerprint(oid('c')), oid('c'));
  assert.notEqual(fingerprints.prDiffFingerprint(Buffer.from([0, 10, 13])), fingerprints.prDiffFingerprint(Buffer.from([0, 10, 10])));
  const commits = [{ subject: 'a:b', body: 'c' }, { subject: 'a', body: 'b:c' }];
  assert.equal(fingerprints.prCommitsFingerprint(commits), fingerprints.prCommitsFingerprint(structuredClone(commits)));
  assert.equal(fingerprints.prCommitsFingerprint(commits), crypto.createHash('sha256').update('a:b\nc\na\nb:c').digest('hex'));
  assert.notEqual(fingerprints.prCommitsFingerprint(commits), fingerprints.prCommitsFingerprint(commits.slice().reverse()));
  assert.equal(fingerprints.snapshotFingerprint({ z: 'x\r\n', a: 1 }), fingerprints.snapshotFingerprint({ a: 1, z: 'x\n' }));

  const validComment = { id: '12', updated_at: 'u', body: 'valid', author_association: 'MEMBER', user: { type: 'User' } };
  assert.notEqual(fingerprints.issueSpecFingerprint({ body: 'body', comments: [validComment] }), fingerprints.issueSpecFingerprint({ body: 'body', comments: [] }));
  assert.equal(
    fingerprints.issueSpecFingerprint({ body: 'body', comments: [{ id: '13', author_association: 'NONE', body: 'outsider' }] }),
    fingerprints.issueSpecFingerprint({ body: 'body', comments: [] }),
  );
  for (const user of [undefined, null, {}, { type: null }, { type: 42 }, { type: '' }]) {
    const malformed = { ...validComment, user };
    assert.throws(() => fingerprints.issueSpecFingerprint({ body: 'body', comments: [malformed] }), (error) => error.code === 'invalid_author_type');
    const routed = cli({ version: 1, operation: 'fingerprint_issue_spec', data: { body: 'body', comments: [malformed] } });
    assert.notEqual(routed.status, 0);
    assert.equal(JSON.parse(routed.stdout).error.code, 'invalid_author_type');
  }
  assert.equal(fingerprints.issueSpecFingerprint({ body: 'body', comments: [{ ...validComment, user: { type: 'Bot' } }] }), fingerprints.issueSpecFingerprint({ body: 'body', comments: [] }));
});

test('Issue #47 writability is conservative for protection, nullability, patterns, and bypass', () => {
  const base = { actorPermission: 'write', actor: 'owner', repository: 'owner/repo', collectedAt: '2026-01-01T00:00:00Z', sourceFingerprint: 'f'.repeat(64), branchProtection: false, complete: true, repositoryRulesetsComplete: true, organizationRulesetsComplete: true, branchRef: 'refs/heads/main', defaultBranch: 'main', repositoryRulesets: [], organizationRulesets: [] };
  assert.equal(writability.evaluateWritability(base).ok, true);
  assert.equal(writability.evaluateWritability({ ...base, complete: false }).ok, false);
  assert.equal(writability.evaluateWritability({ ...base, branchProtection: { protected: true } }).ok, false);
  const global = { name: 'global', target: 'branch', enforcement: 'active', conditions: null, bypass_actors: [], rules: [{ type: 'non_fast_forward' }] };
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [global] }).ok, true);
  const notApplicable = { ...global, name: 'dev-only', conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } }, rules: [{ type: 'pull_request' }] };
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [notApplicable] }).ok, true);
  const tagOnly = { ...global, name: 'tag-only', target: 'tag', conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'pull_request' }] };
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [tagOnly] }).ok, true);
  for (const target of [undefined, null, '']) assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [{ ...global, target }] }).code, 'ambiguous_ruleset_target');
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [{ ...global, target: 'unknown' }] }).code, 'ambiguous_ruleset_target');
  const bypass = { ...global, bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] };
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [bypass] }).code, 'bypass_dependency');
  const unknownGlob = { ...global, conditions: { ref_name: { include: ['refs/heads/mai?'], exclude: [] } } };
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [unknownGlob] }).ok, false);
  assert.equal(writability.refMatches({ include: ['refs/heads/release*'], exclude: [] }, 'refs/heads/release-2026', 'main'), true);
  assert.equal(writability.refMatches({ include: ['refs/heads/release*'], exclude: [] }, 'refs/heads/release/hotfix', 'main'), false);
  assert.equal(writability.refMatches({ include: ['refs/heads/release/*'], exclude: [] }, 'refs/heads/release/hotfix', 'main'), true);
  assert.equal(writability.refMatches({ include: ['refs/heads/release/*'], exclude: [] }, 'refs/heads/release/hotfix/urgent', 'main'), false);
  const nestedReleaseExcluded = {
    ...global,
    conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/release*'] } },
    rules: [{ type: 'pull_request' }],
  };
  assert.equal(writability.evaluateWritability({ ...base, branchRef: 'refs/heads/release/hotfix', repositoryRulesets: [nestedReleaseExcluded] }).code, 'normal_push_restricted');
  const directReleaseExcluded = {
    ...nestedReleaseExcluded,
    conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/release/*'] } },
  };
  assert.equal(writability.evaluateWritability({ ...base, branchRef: 'refs/heads/release/hotfix', repositoryRulesets: [directReleaseExcluded] }).ok, true);
  assert.equal(writability.evaluateWritability({ ...base, branchRef: 'refs/heads/release/hotfix/urgent', repositoryRulesets: [directReleaseExcluded] }).code, 'normal_push_restricted');
  const defaultOnly = { ...global, conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } };
  assert.equal(writability.evaluateWritability({ ...base, branchRef: 'refs/heads/feature', repositoryRulesets: [defaultOnly] }).ok, true);
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [{ ...global, enforcement: 'evaluate', rules: [{ type: 'pull_request' }] }] }).ok, true);
  const organizationRef = { include: ['~DEFAULT_BRANCH'], exclude: [] };
  const orgApplicable = { ...global, conditions: { repository_name: { include: ['repo'], exclude: [], protected: false }, ref_name: organizationRef }, rules: [{ type: 'pull_request' }] };
  assert.equal(writability.evaluateWritability({ ...base, organizationRulesets: [orgApplicable] }).code, 'normal_push_restricted');
  const orgNotApplicable = { ...orgApplicable, conditions: { repository_name: { include: ['other-repo'], exclude: [], protected: false }, ref_name: organizationRef } };
  assert.equal(writability.evaluateWritability({ ...base, organizationRulesets: [orgNotApplicable] }).ok, true);
  assert.equal(writability.evaluateWritability({ ...base, repositoryId: 42, organizationRulesets: [{ ...orgApplicable, conditions: { repository_id: { repository_ids: [42] }, ref_name: organizationRef } }] }).code, 'normal_push_restricted');
  assert.equal(writability.evaluateWritability({ ...base, organizationRulesets: [{ ...orgApplicable, conditions: { repository_name: { include: ['repo'], exclude: [], protected: 'false' }, ref_name: organizationRef } }] }).code, 'ambiguous_ruleset_repository');
  assert.equal(writability.evaluateWritability({ ...base, organizationRulesets: [{ ...orgApplicable, conditions: { repository_property: { include: ['x'] }, ref_name: organizationRef } }] }).code, 'ambiguous_ruleset_repository');
  assert.equal(writability.evaluateWritability({ ...base, repositoryRulesets: [{ ...global, conditions: { ref_name: { include: null, exclude: [] } } }] }).code, 'ambiguous_ruleset_ref');
});

test('Issue #47 operator rejects staged changes and unsafe runtime-root types', () => {
  const repo = makeRepository();
  try {
    fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'staged\n');
    git(repo.root, ['add', 'tracked.txt']);
    const staged = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo), inventoryFn: () => ({ untrackedPaths: [], ignoredInventory: [], runtimeInventory: [] }) });
    assert.equal(staged.ok, true);
    assert.equal(staged.data.clean, false);
    assert.ok(staged.data.indexChanges.length > 0);
    git(repo.root, ['reset', '--', 'tracked.txt']);
    fs.writeFileSync(path.join(repo.root, '.pi-subagents'), 'not a directory');
    const unsafe = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo), inventoryFn: () => ({ untrackedPaths: [], ignoredInventory: [], runtimeInventory: [] }) });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.error.code, 'unsafe_runtime_root');
    const roots = paths.classifyRuntimeRoots(repo.root);
    assert.equal(roots['.pi-subagents'].safe, false);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 operator rejects runtime-root entries independently in HEAD and index', () => {
  const repo = makeRepository();
  try {
    fs.mkdirSync(path.join(repo.root, '.pi'));
    fs.writeFileSync(path.join(repo.root, '.pi', 'state'), 'tracked\n');
    git(repo.root, ['add', '.pi/state']);
    git(repo.root, ['commit', '-m', 'test: track runtime root']);
    repo.head = git(repo.root, ['rev-parse', 'HEAD']);
    let result = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'runtime_root_tracked');

    fs.rmSync(path.join(repo.root, '.pi'), { recursive: true, force: true });
    git(repo.root, ['add', '-u', '--', '.pi']);
    result = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'runtime_root_tracked');
    git(repo.root, ['reset', '--hard', 'HEAD']);

    fs.mkdirSync(path.join(repo.root, '.pi-subagents'));
    fs.writeFileSync(path.join(repo.root, '.pi-subagents', 'state'), 'staged\n');
    git(repo.root, ['add', '.pi-subagents/state']);
    result = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'runtime_root_tracked');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(repo.bare, { recursive: true, force: true }); }
});

test('Issue #47 check classification distinguishes pending, failed, and successful', () => {
  assert.deepEqual(snapshot.classifyChecks([
    { id: 1, name: 'pending', status: 'in_progress', conclusion: null },
    { id: 2, name: 'failed', status: 'completed', conclusion: 'failure' },
    { id: 3, name: 'success', status: 'completed', conclusion: 'success' },
  ]).map(({ pending, failed, successful }) => ({ pending, failed, successful })), [
    { pending: true, failed: false, successful: false },
    { pending: false, failed: true, successful: false },
    { pending: false, failed: false, successful: true },
  ]);
});

test('Issue #47 writability collector fetches complete ruleset details and brackets policy', async () => {
  const calls = [];
  const summary = { id: 7, updated_at: '2026-01-01T00:00:00Z', enforcement: 'active' };
  const detail = { ...summary, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'non_fast_forward' }] };
  const transport = async (_command, args) => {
    calls.push(args);
    const endpoint = args[args.length - 1];
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'User' }, default_branch: 'main', permissions: { push: true } })) };
    if (endpoint === 'user') return { stdout: Buffer.from('{"login":"owner"}') };
    if (String(endpoint).includes('/protection')) { const error = new Error('HTTP 404'); error.stderr = 'HTTP 404'; throw error; }
    if (endpoint === 'repos/owner/repo/rulesets/7') return { stdout: Buffer.from(JSON.stringify(detail)) };
    if (endpoint === 'repos/owner/repo/rulesets') return { stdout: Buffer.from(JSON.stringify([summary])) };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const result = await writability.collectWritability({ owner: 'owner', repo: 'repo', branchRef: 'refs/heads/feature', enterprisePolicyComplete: true, enterpriseRulesets: [], transport });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.source.repositoryRulesets, [detail]);
  assert.equal(calls.filter((args) => args.at(-1) === 'repos/owner/repo/rulesets').length, 2);
  assert.equal(calls.filter((args) => args.at(-1) === 'repos/owner/repo/rulesets/7').length, 1);
  assert.ok(calls.every((args) => args[0] !== 'api' || !String(args.at(-1)).includes('/rulesets') || args.includes('GET')));
});

function paginatedTransport({ stale = false, malformed = false, irrelevantDrift = false, body = 'body' } = {}) {
  const calls = [];
  const fn = async (_command, args) => {
    calls.push(args);
    const endpoint = args[args.length - 1];
    if (args[1] === 'graphql') {
      assert.ok(args.includes('-F'));
      assert.ok(args.some((value) => value === 'owner=owner'));
      const after = args.find((value) => value.startsWith('after='));
      return { stdout: Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: after ? [{ id: 'T2', comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] : [{ id: 'T1', comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'C1' } } } } } })) };
    }
    if (endpoint === 'repos/owner/repo/pulls/47') {
      const pullCount = calls.filter((call) => call[call.length - 1] === endpoint).length;
      const drift = irrelevantDrift && pullCount > 1;
      return { stdout: Buffer.from(JSON.stringify({
        number: 47, state: 'open', draft: false, title: 'title', body,
        user: { login: 'author', type: 'User', id: drift ? 2 : 1, avatar_url: drift ? 'avatar-b' : 'avatar-a' },
        author_association: 'OWNER', html_url: drift ? 'https://example.invalid/b' : 'https://example.invalid/a',
        base: { sha: oid('a'), ref: 'main', repo: { full_name: 'owner/repo', open_issues_count: drift ? 11 : 10 } },
        head: { sha: stale && pullCount > 1 ? oid('d') : oid('b'), ref: 'feature', repo: { full_name: 'owner/repo', open_issues_count: drift ? 11 : 10 } },
        mergeable: true, mergeable_state: 'clean', updated_at: drift ? '2026-02-02T00:00:00Z' : '2026-02-01T00:00:00Z',
      })) };
    }
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'User' }, default_branch: 'main' })) };
    if (String(endpoint).includes('/protection')) return { stdout: Buffer.from('false') };
    const pageArg = args.find((value) => value.startsWith('page='));
    const page = Number(pageArg?.slice(5) || 1);
    if (malformed && String(endpoint).includes('/comments')) return { stdout: Buffer.from('{}') };
    const count = page === 1 && String(endpoint).includes('/issues/') ? 100 : 0;
    if (String(endpoint).includes('/check-runs')) return { stdout: Buffer.from(JSON.stringify({ check_runs: [] })) };
    if (String(endpoint).includes('/check-suites')) return { stdout: Buffer.from(JSON.stringify({ check_suites: [] })) };
    return { stdout: Buffer.from(JSON.stringify(Array.from({ length: count }, (_, index) => ({ id: index + 1 })))) };
  };
  fn.calls = calls;
  return fn;
}

test('Issue #47 snapshot collector collects organization ruleset details', async () => {
  const summary = { id: 8, updated_at: '2026-01-01T00:00:00Z', enforcement: 'active' };
  const detail = { ...summary, rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 1 }] } }], bypass_actors: [] };
  const transport = async (_command, args) => {
    const endpoint = args.at(-1);
    if (endpoint === 'repos/owner/repo/pulls/47') return { stdout: Buffer.from(JSON.stringify({ number: 47, state: 'open', draft: false, title: 'title', body: 'body', base: { sha: oid('a'), ref: 'main', repo: { full_name: 'owner/repo' } }, head: { sha: oid('b'), ref: 'feature', repo: { full_name: 'owner/repo' } } })) };
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'Organization' }, default_branch: 'main' })) };
    if (endpoint === 'repos/owner/repo/rulesets') return { stdout: Buffer.from(JSON.stringify([])) };
    if (endpoint === 'orgs/owner/rulesets') return { stdout: Buffer.from(JSON.stringify([summary])) };
    if (endpoint === 'orgs/owner/rulesets/8') return { stdout: Buffer.from(JSON.stringify(detail)) };
    if (String(endpoint).includes('/protection')) return { stdout: Buffer.from('false') };
    if (String(endpoint).includes('/check-runs')) return { stdout: Buffer.from(JSON.stringify({ check_runs: [] })) };
    if (String(endpoint).includes('/check-suites')) return { stdout: Buffer.from(JSON.stringify({ check_suites: [] })) };
    if (String(endpoint).includes('/annotations')) return { stdout: Buffer.from('[]') };
    if (args[1] === 'graphql') return { stdout: Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } })) };
    return { stdout: Buffer.from('[]') };
  };
  const result = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.policies.organizationRulesets, [detail]);
  assert.equal(result.data.completeness.rulesetDetails, true);
});

test('Issue #47 snapshot collector brackets identity and paginates REST and GraphQL', async () => {
  const transport = paginatedTransport();
  const result = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.threads.length, 2);
  assert.equal(result.data.comments.length, 100);
  assert.equal(result.data.completeness.brackets, true);
  assert.equal(result.data.before.repository, 'owner/repo');
  assert.equal(result.data.before.number, 47);
  assert.equal(result.data.after.repository, 'owner/repo');
  assert.equal(result.data.after.number, 47);
  assert.ok(transport.calls.some((args) => args.some((value) => value === 'after=C1')));
  assert.ok(transport.calls.some((args) => args.some((value) => value === 'page=2')));
});

test('Issue #47 snapshot canonicalizes irrelevant pull metadata and fingerprints relevant changes', async () => {
  const stable = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport: paginatedTransport() });
  const drifted = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport: paginatedTransport({ irrelevantDrift: true }) });
  assert.equal(stable.ok, true, JSON.stringify(stable));
  assert.equal(drifted.ok, true, JSON.stringify(drifted));
  assert.deepEqual(drifted.data.pull, stable.data.pull);
  assert.equal(fingerprints.snapshotFingerprint(drifted.data), fingerprints.snapshotFingerprint(stable.data));
  assert.equal(Object.prototype.hasOwnProperty.call(drifted.data.pull.base.repo, 'open_issues_count'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(drifted.data.pull.user, 'avatar_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(drifted.data.pull, 'html_url'), false);

  const changedBody = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport: paginatedTransport({ body: 'changed body' }) });
  assert.equal(changedBody.ok, true, JSON.stringify(changedBody));
  assert.notEqual(fingerprints.snapshotFingerprint(changedBody.data), fingerprints.snapshotFingerprint(stable.data));
});

test('Issue #47 snapshot collector queries and retains base-branch protection, not head-branch protection', async () => {
  const calls = [];
  const protection = { required_status_checks: { strict: true, contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 1 } };
  const transport = async (_command, args) => {
    calls.push(args);
    const endpoint = args.at(-1);
    if (endpoint === 'repos/owner/repo/pulls/47') return { stdout: Buffer.from(JSON.stringify({ number: 47, state: 'open', draft: false, title: 'title', body: 'body', base: { sha: oid('a'), ref: 'main', repo: { full_name: 'owner/repo' } }, head: { sha: oid('b'), ref: 'feature', repo: { full_name: 'owner/repo' } } })) };
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'User' }, default_branch: 'main' })) };
    if (endpoint === 'repos/owner/repo/branches/main/protection') return { stdout: Buffer.from(JSON.stringify(protection)) };
    if (endpoint === 'repos/owner/repo/branches/feature/protection') throw new Error('head branch protection must not be queried');
    if (args[1] === 'graphql') return { stdout: Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } })) };
    if (String(endpoint).includes('/check-runs')) return { stdout: Buffer.from(JSON.stringify({ check_runs: [] })) };
    if (String(endpoint).includes('/check-suites')) return { stdout: Buffer.from(JSON.stringify({ check_suites: [] })) };
    return { stdout: Buffer.from('[]') };
  };
  const result = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.before.baseBranch, 'main');
  assert.deepEqual(result.data.policies.branchProtection, protection);
  assert.ok(calls.some((args) => args.at(-1) === 'repos/owner/repo/branches/main/protection'));
  assert.ok(!calls.some((args) => args.at(-1) === 'repos/owner/repo/branches/feature/protection'));
});

test('Issue #47 snapshot collector fails closed on movement and malformed pages', async () => {
  const stale = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport: paginatedTransport({ stale: true }) });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_target');
  const malformed = await snapshot.collectSnapshot({ owner: 'owner', repo: 'repo', number: 47, transport: paginatedTransport({ malformed: true }) });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'invalid_schema');
});

test('Issue #47 workspace root allocation rejects preexisting, repository, symlink, and raced paths without operator mutation', () => {
  const repo = makeRepository();
  const parent = temp('i47-workspace-parent-');
  const existing = path.join(parent, 'existing-root');
  const raced = path.join(parent, 'raced-root');
  const inside = path.join(repo.root, 'new-root');
  const target = temp('i47-workspace-target-');
  const link = path.join(parent, 'linked-parent');
  fs.mkdirSync(existing, { mode: 0o755 });
  fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep\n');
  if (process.platform !== 'win32') fs.symlinkSync(target, link);
  const before = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
  const beforeRegistration = git(repo.root, ['worktree', 'list', '--porcelain', '-z']);
  const beforeMode = fs.statSync(repo.root).mode & 0o777;
  const existingMode = fs.statSync(existing).mode & 0o777;
  try {
    const request = (runRoot) => helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(request(existing).ok, false);
    assert.equal(request(repo.root).error.code, 'workspace_inside_repository');
    assert.equal(request(inside).error.code, 'workspace_inside_repository');
    assert.equal(fs.existsSync(inside), false);
    if (process.platform !== 'win32') {
      assert.equal(request(path.join(link, 'child')).ok, false);
      assert.equal(fs.existsSync(path.join(target, 'child')), false);
    }

    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = (file, options) => {
      if (sameDirectoryEntry(file, raced)) {
        originalMkdir(file, options);
        const error = new Error('simulated create race'); error.code = 'EEXIST'; throw error;
      }
      return originalMkdir(file, options);
    };
    try { assert.equal(request(raced).ok, false); } finally { fs.mkdirSync = originalMkdir; }
    assert.equal(fs.existsSync(path.join(raced, 'workspace')), false, 'EEXIST path must never be adopted');
    assert.equal(fs.statSync(existing).mode & 0o777, existingMode);
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.statSync(repo.root).mode & 0o777, beforeMode);
    assert.equal(git(repo.root, ['worktree', 'list', '--porcelain', '-z']), beforeRegistration);
    assert.deepEqual(helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) }).data, before.data);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 real linked workspace lifecycle is detached and identity-guarded', async () => {
  const repo = makeRepository();
  const parent = temp('i47-workspace-parent-');
  const runRoot = path.join(parent, 'workspace-root');
  try {
    const created = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.data.detached, true);
    assert.equal(created.data.registered.HEAD, repo.head);
    assert.equal(samePathIdentity(created.data.root, runRoot), true);
    const verified = helpers.verifyWorkspace(created.data.path, created.data.receipt.creationIdentity);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const forged = structuredClone(created.data.receipt);
    forged.id = 'forged-receipt';
    const blocked = await helpers.cleanupWorkspace(forged, repo.root);
    assert.equal(blocked.ok, false);
    assert.ok(fs.existsSync(created.data.path));
    fs.mkdirSync(path.join(created.data.path, '.pi'));
    fs.writeFileSync(path.join(created.data.path, '.pi', 'state'), 'runtime\n');
    fs.mkdirSync(path.join(created.data.path, '.pi-subagents'));
    fs.writeFileSync(path.join(created.data.path, '.pi-subagents', 'state'), 'runtime\n');
    fs.writeFileSync(path.join(created.data.path, 'correction.txt'), 'correction\n');
    git(created.data.path, ['add', 'correction.txt']);
    git(created.data.path, ['-c', 'user.name=Issue 47 Test', '-c', 'user.email=issue47@example.invalid', 'commit', '-m', 'test: correction']);
    const child = git(created.data.path, ['rev-parse', 'HEAD']);
    assert.equal(helpers.verifyWorkspace(created.data.path, created.data.receipt.creationIdentity, { from: repo.head, to: child }).ok, true);
    fs.writeFileSync(path.join(created.data.path, 'unexpected.txt'), 'unexpected\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, created.data.receipt.creationIdentity, { from: repo.head, to: child }).ok, false);
    fs.rmSync(path.join(created.data.path, 'unexpected.txt'));
    fs.rmSync(path.join(created.data.path, '.pi'), { recursive: true, force: true });
    fs.writeFileSync(path.join(created.data.path, '.pi'), 'unsafe\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, created.data.receipt.creationIdentity, { from: repo.head, to: child }).ok, false);
    fs.rmSync(path.join(created.data.path, '.pi'));
    fs.rmSync(path.join(created.data.path, '.pi-subagents'), { recursive: true, force: true });
    const cleaned = await helpers.cleanupWorkspace(created.data.receipt, repo.root);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    assert.equal(fs.existsSync(created.data.path), false);
  } finally {
    if (fs.existsSync(path.join(runRoot, 'workspace'))) {
      try { git(repo.root, ['worktree', 'remove', '--force', path.join(runRoot, 'workspace')]); } catch {}
    }
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 linked workspace baseline verifies state without a transition', async () => {
  const repo = makeRepository();
  const parent = temp('i47-workspace-state-');
  const runRoot = path.join(parent, 'root');
  let created;
  try {
    created = helpers.createWorkspace({ cwd: repo.root, head: repo.head, tree: repo.tree, runRoot, allowCloneFallback: false });
    assert.equal(created.ok, true, JSON.stringify(created));
    const expected = created.data.receipt.creationIdentity;
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, true);
    fs.mkdirSync(path.join(created.data.path, '.pi'));
    fs.writeFileSync(path.join(created.data.path, '.pi', 'state'), 'runtime\n');
    fs.mkdirSync(path.join(created.data.path, '.pi-subagents'));
    fs.writeFileSync(path.join(created.data.path, '.pi-subagents', 'state'), 'runtime\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, true, 'safe runtime churn is allowed');

    fs.writeFileSync(path.join(created.data.path, 'outside.txt'), 'unexpected\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, false, 'unexpected outside untracked must reject');
    fs.rmSync(path.join(created.data.path, 'outside.txt'));
    fs.writeFileSync(path.join(created.data.path, 'tracked.txt'), 'dirt\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, false, 'tracked worktree dirt must reject');
    git(created.data.path, ['checkout', '--', 'tracked.txt']);
    fs.writeFileSync(path.join(created.data.path, 'staged.txt'), 'staged\n');
    git(created.data.path, ['add', 'staged.txt']);
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, false, 'index dirt must reject');
    git(created.data.path, ['reset', '--', 'staged.txt']);
    fs.rmSync(path.join(created.data.path, 'staged.txt'));
    fs.rmSync(path.join(created.data.path, '.pi'), { recursive: true, force: true });
    fs.writeFileSync(path.join(created.data.path, '.pi'), 'unsafe\n');
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, false, 'unsafe runtime root must reject');
    fs.rmSync(path.join(created.data.path, '.pi'));
    fs.mkdirSync(path.join(created.data.path, '.pi'));
    fs.writeFileSync(path.join(created.data.path, '.pi', 'staged'), 'staged\n');
    git(created.data.path, ['add', '.pi/staged']);
    assert.equal(helpers.verifyWorkspace(created.data.path, expected).ok, false, 'staged runtime root must reject');
    git(created.data.path, ['reset', '--', '.pi/staged']);
    fs.rmSync(path.join(created.data.path, '.pi'), { recursive: true, force: true });
    fs.rmSync(path.join(created.data.path, '.pi-subagents'), { recursive: true, force: true });
    const cleaned = await helpers.cleanupWorkspace(created.data.receipt, repo.root);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    created = null;
  } finally {
    if (created?.data?.path && fs.existsSync(created.data.path)) { try { git(repo.root, ['worktree', 'remove', '--force', created.data.path]); } catch {} }
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 clone workspace baseline verifies state without a transition', () => {
  const repo = makeRepository();
  const parent = temp('i47-clone-state-');
  const clone = path.join(parent, 'clone');
  try {
    git(path.dirname(clone), ['clone', '--no-local', repo.bare, clone]);
    git(clone, ['checkout', '--detach', repo.head]);
    const expected = helpers.inspectWorkspace(clone, clone, { kind: 'clone', head: repo.head, tree: repo.tree, detached: true, originFetch: repo.bare, originPush: repo.bare });
    fs.mkdirSync(path.join(clone, '.pi'));
    fs.writeFileSync(path.join(clone, '.pi', 'state'), 'runtime\n');
    fs.mkdirSync(path.join(clone, '.pi-subagents'));
    fs.writeFileSync(path.join(clone, '.pi-subagents', 'state'), 'runtime\n');
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, true, 'safe runtime churn is allowed');
    fs.writeFileSync(path.join(clone, 'outside.txt'), 'unexpected\n');
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, false, 'unexpected outside untracked must reject');
    fs.rmSync(path.join(clone, 'outside.txt'));
    fs.writeFileSync(path.join(clone, 'tracked.txt'), 'dirt\n');
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, false, 'tracked worktree dirt must reject');
    git(clone, ['checkout', '--', 'tracked.txt']);
    fs.writeFileSync(path.join(clone, 'staged.txt'), 'staged\n');
    git(clone, ['add', 'staged.txt']);
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, false, 'index dirt must reject');
    git(clone, ['reset', '--', 'staged.txt']);
    fs.rmSync(path.join(clone, 'staged.txt'));
    fs.rmSync(path.join(clone, '.pi'), { recursive: true, force: true });
    fs.writeFileSync(path.join(clone, '.pi'), 'unsafe\n');
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, false, 'unsafe runtime root must reject');
    fs.rmSync(path.join(clone, '.pi'));
    fs.mkdirSync(path.join(clone, '.pi'));
    fs.writeFileSync(path.join(clone, '.pi', 'staged'), 'staged\n');
    git(clone, ['add', '.pi/staged']);
    assert.equal(helpers.verifyWorkspace(clone, expected).ok, false, 'staged runtime root must reject');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 default workspace root rejects operator TMPDIR and CLI rejects empty runRoot before mutation', () => {
  const repo = makeRepository();
  try {
    const beforeRegistration = git(repo.root, ['worktree', 'list', '--porcelain', '-z']);
    const beforeInventory = noFollowTopLevelInventory(repo.root);
    const request = { version: 1, operation: 'workspace_create', data: { cwd: repo.root, head: repo.head, tree: repo.tree } };
    const underOperator = spawnSync(process.execPath, [helperCli], {
      cwd: repo.root, input: JSON.stringify(request), encoding: 'utf8',
      env: { ...process.env, TEMP: repo.root, TMP: repo.root, TMPDIR: repo.root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.notEqual(underOperator.status, 0, underOperator.stdout);
    assert.equal(JSON.parse(underOperator.stdout).error.code, 'isolation_temp_inside_checkout');
    assert.equal(git(repo.root, ['worktree', 'list', '--porcelain', '-z']), beforeRegistration);
    assert.deepEqual(noFollowTopLevelInventory(repo.root), beforeInventory);
    assert.equal(noFollowTopLevelInventory(repo.root).some(({ name }) => name.startsWith('pi-autofix-helper-') || name.startsWith('pi-tidd-pr-helper-')), false);

    const captureBeforeInventory = noFollowTopLevelInventory(repo.root);
    const captureBeforeRegistration = git(repo.root, ['worktree', 'list', '--porcelain', '-z']);
    const capture = spawnSync(process.execPath, [helperCli], {
      cwd: repo.root,
      input: JSON.stringify({ version: 1, operation: 'operator_capture', data: { cwd: repo.root, identity: identityFor(repo) } }),
      encoding: 'utf8',
      env: { ...process.env, TEMP: repo.root, TMP: repo.root, TMPDIR: repo.root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.notEqual(capture.status, 0, capture.stdout);
    assert.equal(JSON.parse(capture.stdout).error.code, 'isolation_temp_inside_checkout');
    assert.deepEqual(noFollowTopLevelInventory(repo.root), captureBeforeInventory);
    assert.equal(git(repo.root, ['worktree', 'list', '--porcelain', '-z']), captureBeforeRegistration);
    assert.equal(noFollowTopLevelInventory(repo.root).some(({ name }) => name.startsWith('pi-autofix-helper-') || name.startsWith('pi-tidd-pr-helper-')), false);

    const empty = cli({ version: 1, operation: 'workspace_create', data: { cwd: repo.root, head: repo.head, tree: repo.tree, runRoot: '' } });
    assert.notEqual(empty.status, 0);
    assert.equal(JSON.parse(empty.stdout).error.code, 'invalid_request');
    assert.equal(git(repo.root, ['worktree', 'list', '--porcelain', '-z']), beforeRegistration);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 forced clone fallback transition verifies child and preserves operator baseline', () => {
  const repo = makeRepository();
  const cloneParent = temp('i47-forced-clone-');
  const clone = path.join(cloneParent, 'clone');
  try {
    const captured = helpers.captureOperatorCheckout({ cwd: repo.root, identity: identityFor(repo) });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    git(path.dirname(clone), ['clone', '--no-local', repo.bare, clone]);
    git(clone, ['checkout', '--detach', repo.head]);
    const expected = helpers.inspectWorkspace(clone, clone, { kind: 'clone', head: repo.head, tree: repo.tree, detached: true, originFetch: repo.bare, originPush: repo.bare });
    fs.mkdirSync(path.join(clone, '.pi'));
    fs.writeFileSync(path.join(clone, '.pi', 'state'), 'runtime\n');
    fs.mkdirSync(path.join(clone, '.pi-subagents'));
    fs.writeFileSync(path.join(clone, '.pi-subagents', 'state'), 'runtime\n');
    fs.writeFileSync(path.join(clone, 'correction.txt'), 'clone child\n');
    git(clone, ['add', 'correction.txt']);
    git(clone, ['-c', 'user.name=Issue 47 Test', '-c', 'user.email=issue47@example.invalid', 'commit', '-m', 'test: clone child']);
    const child = git(clone, ['rev-parse', 'HEAD']);
    const verified = helpers.verifyWorkspace(clone, expected, { from: repo.head, to: child });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    fs.writeFileSync(path.join(clone, 'unexpected.txt'), 'unexpected\n');
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: child }).ok, false);
    fs.rmSync(path.join(clone, 'unexpected.txt'));
    fs.rmSync(path.join(clone, '.pi'), { recursive: true, force: true });
    fs.writeFileSync(path.join(clone, '.pi'), 'unsafe\n');
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: child }).ok, false);
    fs.rmSync(path.join(clone, '.pi'));
    fs.rmSync(path.join(clone, '.pi-subagents'), { recursive: true, force: true });
    fs.mkdirSync(path.join(clone, '.pi-subagents'));
    fs.writeFileSync(path.join(clone, '.pi-subagents', 'staged'), 'staged\n');
    git(clone, ['add', '.pi-subagents/staged']);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: child }).ok, false, 'indexed runtime root must reject');
    git(clone, ['reset', '--hard', 'HEAD']);
    fs.mkdirSync(path.join(clone, '.pi'));
    fs.writeFileSync(path.join(clone, '.pi', 'tracked'), 'tracked\n');
    git(clone, ['add', '.pi/tracked']);
    git(clone, ['-c', 'user.name=Issue 47 Test', '-c', 'user.email=issue47@example.invalid', 'commit', '-m', 'test: tracked runtime root']);
    const trackedRoot = git(clone, ['rev-parse', 'HEAD']);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: child, to: trackedRoot }).ok, false, 'HEAD runtime root must reject');
    fs.rmSync(path.join(clone, '.pi'), { recursive: true, force: true });
    git(clone, ['add', '-u', '--', '.pi']);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: child, to: trackedRoot }).ok, false, 'staged runtime-root deletion must reject');
    git(clone, ['reset', '--hard', child]);
    git(clone, ['push', 'origin', 'HEAD:refs/heads/main']);
    assert.equal(helpers.revalidateOperatorCheckout(captured, repo.root).ok, true, 'clone publication must not move operator baseline');

    const env = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const wrongParent = git(clone, ['commit-tree', 'HEAD^{tree}'], env);
    git(clone, ['update-ref', 'HEAD', wrongParent]);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: wrongParent }).ok, false, 'unrelated child must reject');
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: oid('f') }).ok, false, 'missing child must reject');
    git(clone, ['replace', wrongParent, child]);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: wrongParent }).ok, false, 'replacement-spoofed child must reject');
    git(clone, ['replace', '-d', wrongParent]);
    const merge = git(clone, ['commit-tree', 'HEAD^{tree}', '-p', repo.head, '-p', wrongParent], env);
    git(clone, ['update-ref', 'HEAD', merge]);
    assert.equal(helpers.verifyWorkspace(clone, expected, { from: repo.head, to: merge }).ok, false, 'merge child must reject');

    fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'operator drift\n');
    const drift = helpers.revalidateOperatorCheckout(captured, repo.root);
    assert.equal(drift.ok, false, 'clone mode still requires complete operator equality');
  } finally {
    fs.rmSync(cloneParent, { recursive: true, force: true });
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #47 helper surface contains no correction or provider mutation controller', () => {
  for (const name of ['captureOperatorCheckout', 'revalidateOperatorCheckout', 'createWorkspace', 'verifyWorkspace', 'cleanupWorkspace', 'collectSnapshot', 'evaluateWritability']) assert.equal(typeof helpers[name], 'function');
  for (const name of ['commit', 'push', 'reply', 'merge', 'approve', 'resolveThread']) assert.equal(helpers[name], undefined);
});

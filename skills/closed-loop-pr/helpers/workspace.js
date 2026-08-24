'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { run, runSync, gitArgs, assertSafeRepositoryConfig, isolationPaths } = require('./process');
const { createResult, createError } = require('./protocol');
const { assertSymlinkFreePath, lstatKind, classifyRuntimeRoots, normalizeCheckoutPath } = require('./paths');

function nonce() { return crypto.randomBytes(32).toString('base64url'); }
function receiptPath(root) { return path.join(root, '.cleanup-receipt.json'); }
function writeReceipt(root, receipt) {
  const target = receiptPath(root);
  fs.writeFileSync(target, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  return target;
}
function readReceipt(root) {
  const target = receiptPath(root);
  if (lstatKind(target) !== 'file') return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
function canon(file) { return fs.realpathSync.native(file); }
function git(cwd, args, phase, options = {}) { return runSync('git', gitArgs(args), { cwd, phase, acceptExitCodes: options.acceptExitCodes }).trim(); }
function gitRaw(cwd, args, phase) { return Buffer.from(runSync('git', gitArgs(args), { cwd, phase, encoding: 'buffer' })).toString('utf8'); }
function parseWorktrees(cwd) {
  return git(cwd, ['worktree', 'list', '--porcelain', '-z'], 'workspace_verify').split('\0\0').filter(Boolean).map((block) => {
    const fields = {};
    for (const line of block.split('\0').filter(Boolean)) { const i = line.indexOf(' '); fields[i < 0 ? line : line.slice(0, i)] = i < 0 ? true : line.slice(i + 1); }
    return fields;
  });
}
function pathKey(file) {
  const absolute = path.resolve(file);
  let current = absolute;
  const missing = [];
  for (;;) {
    try {
      const resolved = path.join(canon(current), ...missing);
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
function symlinkFreePathKey(file) {
  let current = path.resolve(file);
  for (;;) {
    let kind;
    try { kind = lstatKind(current); }
    catch (error) { if (error.code === 'ENOTDIR') return null; throw error; }
    if (kind === 'symlink') return null;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return pathKey(file);
}
function registrationAtPath(records, workspace) {
  const expected = symlinkFreePathKey(workspace);
  if (!expected) return null;
  return records.find((item) => item.worktree && symlinkFreePathKey(item.worktree) === expected) || null;
}
function registration(cwd, workspace) {
  // Symlink-free exact-path lookup only. `pathKey` canonicalizes the existing ancestors of both
  // sides, so a registration Git recorded under another spelling still matches, and
  // `symlinkFreePathKey` refuses a path whose ancestor is a symlink. A registration reachable
  // only by following a symlink is deliberately not matched: the no-follow rule that governs
  // runtime roots governs registration identity too, and the caller then fails closed.
  const record = registrationAtPath(parseWorktrees(cwd), workspace);
  if (!record || lstatKind(record.worktree) !== 'directory') return null;
  try { return canon(record.worktree) === canon(workspace) ? record : null; } catch { return null; }
}
function recoveryEvidence({ repository, commonGitDir, workspace, expectedHead, record, root, runRootSource }) {
  const pathKind = lstatKind(workspace);
  const normalized = record ? {
    worktree: path.resolve(record.worktree),
    head: record.HEAD || null,
    detached: record.detached === true && !record.branch,
    branch: record.branch || null,
    prunable: Object.hasOwn(record, 'prunable') ? { present: true, reason: typeof record.prunable === 'string' ? record.prunable : '' } : { present: false, reason: null },
    locked: Object.hasOwn(record, 'locked') ? { present: true, reason: typeof record.locked === 'string' ? record.locked : '' } : { present: false, reason: null },
  } : null;
  const registrationKey = normalized && symlinkFreePathKey(normalized.worktree);
  const workspaceKey = symlinkFreePathKey(workspace);
  const exact = Boolean(registrationKey && workspaceKey && registrationKey === workspaceKey);
  const eligible = Boolean(exact && pathKind === 'absent' && normalized.detached && normalized.head === expectedHead && !normalized.locked.present);
  return {
    classification: pathKind !== 'absent' ? 'path_occupied' : !exact ? 'missing_path_without_registration' : eligible ? 'exact_missing_detached_registration' : 'registration_identity_mismatch',
    repository: canon(repository),
    commonGitDir: canon(commonGitDir),
    workspacePath: path.resolve(workspace),
    expectedHead,
    pathKind,
    followed: false,
    registration: normalized,
    receiptPresent: lstatKind(receiptPath(root)) === 'file',
    validRunOwnedReceipt: false,
    runRootSource,
    exactRemovalCandidate: eligible,
  };
}
function detached(cwd) { return git(cwd, ['symbolic-ref', '-q', 'HEAD'], 'workspace_verify', { acceptExitCodes: [1] }) === ''; }
function remoteIdentity(workspace) {
  const originFetch = git(workspace, ['remote', 'get-url', 'origin'], 'workspace_verify');
  let originPush; try { originPush = git(workspace, ['remote', 'get-url', '--push', 'origin'], 'workspace_verify'); } catch { originPush = originFetch; }
  return { originFetch, originPush };
}
function inspectWorkspace(workspace, repositoryCwd, expected = {}) {
  const workspacePath = canon(workspace);
  const repository = canon(git(workspacePath, ['rev-parse', '--show-toplevel'], 'workspace_verify'));
  const head = git(workspacePath, ['rev-parse', 'HEAD'], 'workspace_verify');
  const tree = git(workspacePath, ['rev-parse', 'HEAD^{tree}'], 'workspace_verify');
  const gitDir = canon(git(workspacePath, ['rev-parse', '--absolute-git-dir'], 'workspace_verify'));
  const commonRaw = git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'workspace_verify');
  const commonGitDir = canon(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(workspacePath, commonRaw));
  const registered = expected.kind === 'clone' ? null : registration(repositoryCwd || workspacePath, workspacePath);
  const identity = { kind: expected.kind || 'linked', path: workspacePath, repository, head, tree, detached: detached(workspacePath), gitDir, commonGitDir, registered, ...remoteIdentity(workspacePath) };
  const immutable = ['kind', 'path', 'detached', 'gitDir', 'commonGitDir', 'originFetch', 'originPush'];
  const matches = immutable.every((field) => expected[field] === undefined || JSON.stringify(identity[field]) === JSON.stringify(expected[field]))
    && (expected.head === undefined || identity.head === expected.head)
    && (expected.tree === undefined || identity.tree === expected.tree)
    && (expected.registered === undefined || (expected.registered === null ? identity.registered === null : identity.registered && expected.registered.worktree === identity.registered.worktree));
  return { ...identity, matches };
}
function transitionError(message) { const error = new Error(message); error.code = 'invalid_transition'; throw error; }
function workspaceStateError(code, message) { const error = new Error(message); error.code = code; error.phase = 'workspace_verify'; throw error; }
function gitPathBytes(cwd, args) {
  return Buffer.from(runSync('git', gitArgs(args), { cwd, phase: 'workspace_verify', encoding: 'buffer' }));
}
function stableGitPaths(cwd, args) {
  const first = gitPathBytes(cwd, args);
  const second = gitPathBytes(cwd, args);
  if (!first.equals(second)) workspaceStateError('workspace_state_unstable', 'Git path inventory changed during workspace verification');
  return gitPathsFromBytes(first, cwd);
}
function gitPathsFromBytes(bytes, cwd) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths = [];
  let start = 0;
  try {
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0) continue;
      if (index === start) transitionError('malformed Git path inventory');
      paths.push(normalizeCheckoutPath(decoder.decode(bytes.subarray(start, index)), cwd));
      start = index + 1;
    }
    if (start !== bytes.length) transitionError('unterminated Git path inventory');
  } catch (error) {
    if (error.code === 'invalid_transition') throw error;
    transitionError('Git path inventory contains non-UTF-8 or malformed paths');
  }
  return paths;
}
function runtimeTransitionPaths(paths) {
  return paths.filter((entry) => ['.pi', '.pi-subagents'].some((root) => entry === root || entry.startsWith(`${root}/`)));
}
function verifyWorkspaceState(workspace) {
  const untrackedPaths = stableGitPaths(workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedPaths.some((entry) => !runtimeTransitionPaths([entry]).length)) workspaceStateError('unexpected_untracked', 'workspace contains unexpected non-runtime untracked paths');

  const runtimeRoots = classifyRuntimeRoots(workspace);
  if (Object.values(runtimeRoots).some((descriptor) => !descriptor.safe)) workspaceStateError('unsafe_runtime_root', 'workspace contains an unsafe runtime root');

  const headPaths = stableGitPaths(workspace, ['--no-replace-objects', 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', '.pi', '.pi-subagents']);
  const indexPaths = stableGitPaths(workspace, ['ls-files', '-z', '--', '.pi', '.pi-subagents']);
  if (headPaths.length || indexPaths.length) workspaceStateError('runtime_root_tracked', 'runtime root is present in HEAD or index');
  if (git(workspace, ['status', '--porcelain=v1', '--untracked-files=no'], 'workspace_verify') !== '') workspaceStateError('workspace_not_clean', 'workspace tracked or index state is not clean');
  return { untrackedPaths, runtimeRoots };
}
function verifyTransition(workspace, transition) {
  if (!transition || typeof transition !== 'object' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(transition.from) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(transition.to)) transitionError('transition requires from and to OIDs');
  if (git(workspace, ['--no-replace-objects', 'cat-file', '-t', transition.to], 'workspace_verify') !== 'commit') transitionError('transition target must be a commit');
  const raw = gitRaw(workspace, ['--no-replace-objects', 'cat-file', '-p', transition.to], 'workspace_verify');
  const separator = raw.indexOf('\n\n');
  if (separator < 0) transitionError('transition commit header is incomplete');
  const header = raw.slice(0, separator);
  const parents = header.split('\n').filter((line) => line.startsWith('parent ')).map((line) => line.slice('parent '.length));
  if (parents.length !== 1 || parents[0] !== transition.from) transitionError('transition target must have the sole expected parent');
  if (git(workspace, ['--no-replace-objects', 'rev-parse', 'HEAD'], 'workspace_verify') !== transition.to) transitionError('workspace HEAD does not match transition target');
}
function verifyWorkspace(cwd, expected, transition) {
  try {
    if (!expected || typeof expected !== 'object' || !expected.path) throw new Error('expected workspace identity is required');
    const transitionExpected = transition ? { ...expected, head: undefined, tree: undefined } : expected;
    const actual = inspectWorkspace(cwd || expected.path, expected.repositoryCwd, transitionExpected);
    verifyWorkspaceState(actual.path);
    if (!actual.matches) return createError('workspace_verify', 'identity_mismatch', 'workspace identity differs from receipt', 'workspace_verify');
    if (transition) verifyTransition(actual.path, transition);
    return createResult('workspace_verify', actual);
  } catch (error) { return createError('workspace_verify', error.code || 'verification_failed', error.message, error.phase || 'workspace_verify'); }
}
function isInside(child, parent) { return child === parent || child.startsWith(`${parent}${path.sep}`); }
function runRootError(code, message) { const error = new Error(message); error.code = code; throw error; }
function verifyCreatedRoot(root, repository) {
  assertSymlinkFreePath(root);
  if (lstatKind(root) !== 'directory') runRootError('run_root_create_failed', 'created run root must be a directory');
  const canonical = canon(root);
  if (isInside(canonical, repository)) runRootError('workspace_inside_repository', 'run root must be external');
  return canonical;
}
function allocateRoot(runRoot, repository) {
  if (runRoot !== undefined && (typeof runRoot !== 'string' || runRoot.trim().length === 0)) runRootError('invalid_run_root', 'run root must be a nonempty string');
  if (runRoot === undefined) {
    const temporaryParent = path.resolve(os.tmpdir());
    assertSymlinkFreePath(temporaryParent);
    if (lstatKind(temporaryParent) !== 'directory') runRootError('run_root_parent_invalid', 'temporary run root parent must be an existing directory');
    const canonicalParent = canon(temporaryParent);
    if (isInside(canonicalParent, repository)) runRootError('workspace_inside_repository', 'run root must be external');
    let root;
    try { root = fs.mkdtempSync(path.join(canonicalParent, 'pi-autofix-helper-')); }
    catch (error) { error.code = error.code || 'run_root_create_failed'; throw error; }
    return verifyCreatedRoot(root, repository);
  }
  const requested = path.resolve(runRoot);
  if (isInside(requested, repository)) runRootError('workspace_inside_repository', 'run root must be external');
  const parent = path.dirname(requested);
  assertSymlinkFreePath(parent);
  if (lstatKind(parent) !== 'directory') runRootError('run_root_parent_invalid', 'run root parent must be an existing directory');
  const root = path.join(canon(parent), path.basename(requested));
  if (isInside(root, repository)) runRootError('workspace_inside_repository', 'run root must be external');
  assertSymlinkFreePath(root);
  if (lstatKind(root) !== 'absent') runRootError('run_root_exists', 'explicit run root must not already exist');
  try { fs.mkdirSync(root, { recursive: false, mode: 0o700 }); }
  catch (error) { error.code = error.code || 'run_root_create_failed'; throw error; }
  return verifyCreatedRoot(root, repository);
}
function adminInventory(commonGitDir) {
  const worktrees = path.join(commonGitDir, 'worktrees');
  if (!fs.existsSync(worktrees)) return [];
  return fs.readdirSync(worktrees).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((name) => ({ name, kind: lstatKind(path.join(worktrees, name)) }));
}
function cloneFallback({ repository, workspace, head, tree, root, beforeRegistration, beforeAdmin, expectedFetch, expectedPush, commonGitDir, runRootSource }) {
  const currentRegistration = parseWorktrees(repository);
  const noSideEffect = lstatKind(workspace) === 'absent'
    && JSON.stringify(beforeRegistration) === JSON.stringify(currentRegistration)
    && JSON.stringify(beforeAdmin) === JSON.stringify(adminInventory(commonGitDir));
  if (!noSideEffect) return createError('workspace', 'partial_creation', 'linked creation changed path or Git administration', 'workspace_create', {
    recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: registrationAtPath(currentRegistration, workspace), root, runRootSource }),
  });
  const clonePath = path.join(root, 'clone');
  try {
    git(root, ['clone', '--no-checkout', '--no-local', expectedFetch, clonePath], 'workspace_clone');
    git(clonePath, ['remote', 'set-url', '--push', 'origin', expectedPush], 'workspace_clone');
    git(clonePath, ['checkout', '--detach', head], 'workspace_clone');
    const actual = inspectWorkspace(clonePath, clonePath, { kind: 'clone', head, tree, detached: true, originFetch: expectedFetch, originPush: expectedPush });
    if (!actual.matches) return createError('workspace', 'clone_identity_mismatch', 'clone fallback identity mismatch', 'workspace_verify');
    return createResult('workspace', { ...actual, root, kind: 'clone', cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' });
  } catch (error) { return createError('workspace', 'clone_fallback_failed', error.message, 'workspace_clone', { retainedPath: fs.existsSync(clonePath) ? clonePath : null }); }
}
function createWorkspace({ cwd, head, tree, runRoot, allowCloneFallback = true }) {
  try {
    const repository = canon(git(cwd, ['rev-parse', '--show-toplevel'], 'workspace_create'));
    assertSafeRepositoryConfig(repository);
    const expectedRemotes = remoteIdentity(repository);
    const commonRaw = git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'workspace_create');
    const commonGitDir = canon(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repository, commonRaw));
    const root = allocateRoot(runRoot, repository);
    const workspace = path.join(root, 'workspace');
    const runRootSource = runRoot === undefined ? 'generated' : 'explicit';
    const beforeRegistration = parseWorktrees(repository); const beforeAdmin = adminInventory(commonGitDir);
    const existing = registrationAtPath(beforeRegistration, workspace);
    if (existing) return createError('workspace', 'workspace_registration_collision', 'requested workspace path already has a Git worktree registration', 'workspace_create', {
      recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: existing, root, runRootSource }),
    });
    if (lstatKind(workspace) !== 'absent') return createError('workspace', 'workspace_path_occupied', 'requested workspace path is not absent', 'workspace_create', {
      recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: null, root, runRootSource }),
    });
    try { git(repository, ['worktree', 'add', '--detach', workspace, head], 'workspace_create'); }
    catch (error) {
      const afterRegistration = parseWorktrees(repository); const afterAdmin = adminInventory(commonGitDir);
      const record = registrationAtPath(afterRegistration, workspace);
      const noSideEffect = lstatKind(workspace) === 'absent'
        && JSON.stringify(beforeRegistration) === JSON.stringify(afterRegistration)
        && JSON.stringify(beforeAdmin) === JSON.stringify(afterAdmin);
      if (!noSideEffect) return createError('workspace', 'partial_creation', 'linked creation changed path or Git administration', 'workspace_create', {
        recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record, root, runRootSource }),
      });
      if (!allowCloneFallback) return createError('workspace', 'linked_unavailable', error.message, 'workspace_create', {
        recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: null, root, runRootSource }),
      });
      return cloneFallback({ repository, workspace, head, tree, root, beforeRegistration, beforeAdmin, commonGitDir, runRootSource, expectedFetch: expectedRemotes.originFetch, expectedPush: expectedRemotes.originPush });
    }
    let actual;
    try { actual = inspectWorkspace(workspace, repository, { kind: 'linked', head, tree, detached: true, ...expectedRemotes }); }
    catch (error) {
      const records = parseWorktrees(repository);
      return createError('workspace', 'partial_creation', 'linked workspace could not be verified after Git reported success', 'workspace_verify', {
        recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: registrationAtPath(records, workspace), root, runRootSource }),
      });
    }
    if (!actual.matches || !actual.registered || actual.registered.branch || actual.registered.HEAD !== head) return createError('workspace', 'identity_mismatch', 'linked workspace identity/registration mismatch', 'workspace_verify', {
      recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: actual.registered, root, runRootSource }),
    });
    const id = nonce();
    const stored = { version: 1, id, repositoryCwd: repository, creationIdentity: { ...actual, repositoryCwd: repository } };
    let storedPath;
    try { storedPath = writeReceipt(root, stored); }
    catch (error) {
      return createError('workspace', 'partial_creation', 'linked workspace receipt could not be created', 'workspace_create', {
        recovery: recoveryEvidence({ repository, commonGitDir, workspace, expectedHead: head, record: actual.registered, root, runRootSource }),
      });
    }
    const receipt = { version: 1, id, root, storedPath, repositoryCwd: repository, creationIdentity: stored.creationIdentity };
    return createResult('workspace', { ...actual, root, kind: 'linked', receipt, cleanupAllowed: true });
  } catch (error) { return createError('workspace', error.code || 'workspace_failed', error.message, error.phase || 'workspace_create'); }
}
async function cleanupWorkspace(input, cwd) {
  try {
    const receipt = input?.data?.receipt || input?.receipt || input;
    if (!receipt?.root || !receipt?.storedPath || path.resolve(receipt.storedPath) !== receiptPath(path.resolve(receipt.root))) return createError('workspace_cleanup', 'cleanup_not_authorized', 'run-owned cleanup receipt path required', 'workspace_cleanup');
    assertSymlinkFreePath(receipt.root);
    const stored = readReceipt(receipt.root);
    const creation = stored?.creationIdentity;
    const validReceipt = stored && stored.version === 1 && stored.id === receipt.id && receipt.version === 1
      && JSON.stringify(receipt.creationIdentity) === JSON.stringify(creation);
    if (!validReceipt || creation.kind !== 'linked') return createError('workspace_cleanup', 'cleanup_not_authorized', 'matching run-owned linked receipt required', 'workspace_cleanup');
    const repositoryCwd = cwd || receipt.repositoryCwd;
    const actual = inspectWorkspace(creation.path, repositoryCwd, { ...creation, head: undefined, tree: undefined, registered: creation.registered });
    if (!actual.matches || !actual.registered || actual.registered.branch) return createError('workspace_cleanup', 'identity_mismatch', 'workspace administrative identity changed before cleanup', 'workspace_cleanup');
    await run('git', gitArgs(['worktree', 'remove', actual.path]), { cwd: repositoryCwd, phase: 'workspace_cleanup' });
    if (fs.existsSync(actual.path) || parseWorktrees(repositoryCwd).some((item) => item.worktree === actual.path)) return createError('workspace_cleanup', 'cleanup_incomplete', 'workspace removal was incomplete', 'workspace_cleanup');
    fs.unlinkSync(receipt.storedPath);
    return createResult('workspace_cleanup', { removed: true, path: actual.path, terminalHead: actual.head, terminalTree: actual.tree, id: receipt.id });
  } catch (error) { return createError('workspace_cleanup', error.code || 'cleanup_failed', error.message, error.phase || 'workspace_cleanup'); }
}

module.exports = { createWorkspace, verifyWorkspace, cleanupWorkspace, inspectWorkspace, parseWorktrees, adminInventory };

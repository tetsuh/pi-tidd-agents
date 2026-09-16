'use strict';

// Issue #125 (CL-D73), split from workspace.js without change: what a workspace is, read from Git — path
// identity that never follows a symlink, the worktree registration Git records, and the administrative
// identity that workspace_create, workspace_verify and workspace_cleanup each compare against a stored
// receipt. `workspace.js` is its only consumer, and re-exports what the packaged surface already offered.

const fs = require('node:fs');
const path = require('node:path');
const { runSync, gitArgs } = require('./process');
const { lstatKind } = require('./paths');

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

module.exports = { canon, git, gitRaw, parseWorktrees, symlinkFreePathKey, registrationAtPath, remoteIdentity, inspectWorkspace };

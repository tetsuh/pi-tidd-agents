'use strict';

// Issue #181 (CL-D89): the bounded batch's one normal commit and one non-force push, as packaged operations the writer
// invokes. Both run in the workspace the run created, under the same isolated Git configuration as every other Git
// command, plus exactly what that isolation removes and the operation needs: the commit gets the operator identity
// `operator_capture` recorded at preflight, and the push gets one named credential helper, `gh auth git-credential`.
// The writer stays the sole writer; these operations decide nothing and grant nothing beyond CL-D30's one commit and
// one non-force push per batch.

const os = require('node:os');
const path = require('node:path');
const { runSync, gitArgs } = require('./process');
const { createResult, createError } = require('./protocol');
const { absoluteSpelling } = require('./composition');

function text(value) { return typeof value === 'string' && value.length > 0; }
function fail(code, message, phase, details) { throw Object.assign(new Error(message), { code, phase, details }); }
function wrap(operation, body) {
  try { return createResult(operation, body()); }
  catch (error) { return createError(operation, error.code || 'helper_failed', error.message, error.phase || operation, error.details); }
}
// The workspace is created.path, never a path beside it (CL-D88's rule, applied to these operations).
function workspaceOf(created, phase) {
  const cwd = created && created.path;
  if (!text(cwd) || cwd.includes(String.fromCharCode(0)) || !cwd.isWellFormed() || !absoluteSpelling(cwd)) fail('invalid_request', 'created must name the run-owned workspace by an absolute path', phase);
  return cwd;
}
function git(cwd, args, phase, options = {}) {
  return runSync('git', gitArgs(args), { cwd, phase, ...options });
}

function commitCreate(data) {
  return wrap('commit_create', () => {
    const phase = 'commit_create';
    const cwd = workspaceOf(data.created, phase);
    const identity = data.captured && data.captured.data && data.captured.data.commitIdentity;
    if (!identity || !text(identity.name) || !text(identity.email)) fail('invalid_request', 'captured carries no commit identity; the capture predates CL-D89', phase);
    if (typeof data.message !== 'string' || !data.message.trim()) fail('invalid_request', 'message must be the approved, nonempty commit message', phase);
    const parent = git(cwd, ['rev-parse', 'HEAD'], phase).trim();
    // `diff --cached --quiet` exits 1 exactly when something is staged.
    let staged = false;
    try { git(cwd, ['diff', '--cached', '--quiet'], phase); } catch (error) { if (error.exitCode === 1) staged = true; else throw error; }
    if (!staged) fail('nothing_staged', 'the index carries no staged change to commit', phase);
    // Git prefers the identity variables over configuration, so they are set to the captured identity too: an ambient
    // value can never replace it. The message goes on stdin as real bytes, so no literal `\n` can reach it.
    const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
    git(cwd, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--no-verify', '-F', '-', '--cleanup=whitespace'], phase, { stdin: data.message, env });
    const commit = git(cwd, ['rev-parse', 'HEAD'], phase).trim();
    const parents = git(cwd, ['rev-list', '--parents', '-n', '1', commit], phase).trim().split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== parent) fail('guard_failed', 'the new commit is not the sole child of the head it was made on', phase, { parent, parents });
    return { commit, parent };
  });
}

// Isolation empties `credential.helper` and replaces HOME, so the operator's helper never runs. The push clears the
// inherited list and names exactly one helper; gh is the authentication the run already uses for snapshots and
// replies. No force in any form: a remote that moved refuses the push.
function pushArgs(branch) {
  return gitArgs(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `HEAD:refs/heads/${branch}`]);
}
// gh finds its own configuration from the operator's environment, not the isolated one.
function ghConfigDir() {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'gh');
  return path.join(os.homedir(), '.config', 'gh');
}

function pushPublish(data) {
  return wrap('push_publish', () => {
    const phase = 'push_publish';
    const cwd = workspaceOf(data.created, phase);
    const branch = data.captured && data.captured.data && data.captured.data.identity && data.captured.data.identity.headBranch;
    if (!text(branch)) fail('invalid_request', 'captured names no PR head branch', phase);
    git(cwd, ['check-ref-format', `refs/heads/${branch}`], phase);
    const head = git(cwd, ['rev-parse', 'HEAD'], phase).trim();
    const env = process.platform === 'win32' ? {} : { GH_CONFIG_DIR: ghConfigDir() };
    runSync('git', pushArgs(branch), { cwd, phase, env, timeout: 120000 });
    return { head, ref: `refs/heads/${branch}` };
  });
}

module.exports = { commitCreate, pushPublish, pushArgs };

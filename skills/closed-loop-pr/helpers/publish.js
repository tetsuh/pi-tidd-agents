'use strict';

// Issue #181 (CL-D89): the bounded batch's one normal commit and one non-force push, as packaged operations the writer
// invokes. Both run in the workspace the run created, under the same isolated Git configuration as every other Git
// command, plus exactly what that isolation removes and the operation needs: the commit gets the operator identity
// `operator_capture` recorded at preflight, and the push gets one named credential helper, `gh auth git-credential`.
// The writer stays the sole writer; these operations decide nothing and grant nothing beyond CL-D30's one commit and
// one non-force push per batch.

const os = require('node:os');
const path = require('node:path');
const { runSync, gitArgs, assertSafeRepositoryConfig } = require('./process');
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
    git(cwd, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'i18n.commitEncoding=UTF-8', 'commit', '--no-verify', '-F', '-', '--cleanup=whitespace'], phase, { stdin: data.message, env });
    const commit = git(cwd, ['rev-parse', 'HEAD'], phase).trim();
    const parents = git(cwd, ['rev-list', '--parents', '-n', '1', commit], phase).trim().split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== parent) fail('guard_failed', 'the new commit is not the sole child of the head it was made on', phase, { parent, parents });
    return { commit, parent };
  });
}

// Isolation empties `credential.helper` and replaces HOME, so the operator's helper never runs. The push clears the
// inherited list and names exactly one helper; gh is the authentication the run already uses for snapshots and
// replies. No force in any form: a remote that moved refuses the push. Configuration cannot widen it either: no tags,
// no submodules, no signing ride along with the one branch.
function pushArgs(branch) {
  return gitArgs(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--no-follow-tags', '--recurse-submodules=no', '--no-signed', 'origin', `HEAD:refs/heads/${branch}`]);
}
// gh finds its own configuration from the operator's environment, not the isolated one: the isolation sets
// XDG_CONFIG_HOME on every platform, and gh consults it before its Windows default, so the directory is always named.
function ghConfigDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh');
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'GitHub CLI');
  return path.join(home, '.config', 'gh');
}

function pushPublish(data) {
  return wrap('push_publish', () => {
    const phase = 'push_publish';
    const cwd = workspaceOf(data.created, phase);
    const captured = data.captured;
    // The CLI's shape check already requires this; a direct caller is held to it too.
    if (!captured || captured.ok !== true || captured.operation !== 'operator_capture' || !captured.data) fail('invalid_request', 'captured must be a successful operator_capture envelope', phase);
    const identity = captured.data.identity || {};
    const branch = identity.headBranch;
    if (!text(branch)) fail('invalid_request', 'captured names no PR head branch', phase);
    // Only the gh helper may authenticate the push. An https remote is its; a local path needs no credential. Any other
    // transport (SSH above all) would be reached with the operator's own keys instead, so it is refused.
    // The URL checked is the one Git would push to: the workspace's own origin, rewrites applied, which must also be the
    // URL the capture and the workspace creation recorded. Credentials inside an https URL would authenticate the push
    // instead of that helper, so they are refused too.
    // git push origin publishes to every push URL, so every one is read, and there must be exactly one.
    const pushUrls = git(cwd, ['remote', 'get-url', '--push', '--all', 'origin'], phase).split('\n').filter(Boolean);
    if (pushUrls.length !== 1) fail('invalid_request', `the workspace origin pushes to ${pushUrls.length} URLs; exactly one is allowed`, phase);
    const pushUrl = pushUrls[0];
    if (pushUrl !== identity.originPush || pushUrl !== data.created.originPush) fail('invalid_request', 'the workspace push URL differs from the one the capture and the workspace recorded', phase, { pushUrl });
    if (/^https:\/\/[^/]*@/i.test(pushUrl)) fail('invalid_request', 'the captured push URL carries credentials, which would authenticate the push instead of the gh credential helper', phase);
    if (!/^https:\/\//i.test(pushUrl) && !/^file:\/\//i.test(pushUrl) && !(absoluteSpelling(pushUrl) && !/^[^/\\]*@/.test(pushUrl))) fail('invalid_request', 'the captured push URL is neither https nor a local path, so the gh credential helper cannot be the one that authenticates it', phase);
    git(cwd, ['check-ref-format', `refs/heads/${branch}`], phase);
    // Configuration that would widen the push or authenticate it by other means is refused before Git runs: mirror
    // semantics, a remote-helper program, extra HTTP headers, and push options sent to the server.
    // Preflight's unsafe-key check is repeated here, because configuration can change after it, and every http.* key and
    // the remote's proxy are refused too: TLS, resolution, proxy, and header settings decide which peer receives the
    // gh credential.
    try { assertSafeRepositoryConfig(cwd); } catch (error) { error.phase = phase; throw error; }
    const widening = git(cwd, ['config', '--get-regexp', '^(remote\\.origin\\.(mirror|vcs|proxy)|push\\.pushoption|http\\..*)$'], phase, { acceptExitCodes: [1] }).trim();
    if (widening) fail('invalid_request', 'repository configuration would widen the push or authenticate it by other means', phase, { keys: widening.split('\n').map((line) => line.split(' ')[0]) });
    const head = git(cwd, ['rev-parse', 'HEAD'], phase).trim();
    // The pushed history is this run's: HEAD descends from the public head the capture verified.
    try { git(cwd, ['merge-base', '--is-ancestor', String(captured.data.head), head], phase); }
    catch (error) { if (error.exitCode === 1 || error.exitCode === 128) fail('guard_failed', 'HEAD does not descend from the captured public head', phase, { captured: String(captured.data.head), head }); throw error; }
    runSync('git', pushArgs(branch), { cwd, phase, env: { GH_CONFIG_DIR: ghConfigDir() }, timeout: 120000 });
    return { head, ref: `refs/heads/${branch}` };
  });
}

module.exports = { commitCreate, pushPublish, pushArgs, ghConfigDir };

'use strict';

// Issue #181 (CL-D89) — exact-autofix attempt 8 on PR #178 reached the writer, passed every guard and all 984 tests,
// and then failed at the one normal commit with `Author identity unknown`: every Git command runs under isolated
// config, and isolated config carries no `user.name` or `user.email`. The push has the same gap, because the
// isolation empties `credential.helper` and replaces `HOME`, so the operator's `gh auth git-credential` helper never
// runs. `operator_capture` now records the operator checkout's effective identity at preflight and refuses a run
// without one; `commit_create` and `push_publish` are packaged operations the writer invokes, the first passing
// exactly that identity, the second naming exactly one credential helper, `gh auth git-credential`.
//
// TDD provenance: behavioural RED — the capture carries no identity and neither operation exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { readText, sectionOf } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const NAME = 'Issue 181 Test';
const EMAIL = 'issue181@example.invalid';
const MESSAGE = 'fix: correct the thing (#181)\n\nIssue: #181\nTests: npm test\n';

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
// A home with no Git configuration, so nothing but the repository's own config can supply an identity.
function bareHome() {
  const home = temp('i181-home-');
  return { HOME: home, XDG_CONFIG_HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' };
}
function cli(operation, data, env = {}) {
  const result = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(result.stdout);
}
function repository({ name = NAME, email = EMAIL } = {}) {
  const root = temp('i181-repo-');
  git(root, ['init', '-b', 'main']);
  if (name !== null) git(root, ['config', 'user.name', name]);
  if (email !== null) git(root, ['config', 'user.email', email]);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: base']);
  const bare = temp('i181-origin-');
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'main']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const identity = { repository: 'owner/repo', prNumber: 181, lifecycle: 'OPEN', baseOid: 'a'.repeat(40), publicHead: head, headRepository: 'owner/repo', headBranch: 'main', originFetch: bare, originPush: bare };
  return { root, bare, head, tree: git(root, ['rev-parse', 'HEAD^{tree}']), identity };
}
// The run's own preflight and workspace, both produced by the packaged operations.
function run(env = bareHome()) {
  const repo = repository();
  const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, env);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const created = cli('workspace_create', { cwd: repo.root, head: repo.head, tree: repo.tree }, env);
  assert.equal(created.ok, true, JSON.stringify(created));
  return { repo, captured, created: created.data, env };
}
function stageCorrection(workspace) {
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'corrected\n');
  git(workspace, ['add', 'tracked.txt']);
}

test('Issue #181 operator_capture records the operator checkout identity at preflight', () => {
  const repo = repository();
  const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, bareHome());
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(captured.data.commitIdentity, { name: NAME, email: EMAIL });
  const { OPERATOR_CAPTURE_PAYLOAD_KEYS } = require('../skills/closed-loop-pr/helpers/operator');
  assert.ok(OPERATOR_CAPTURE_PAYLOAD_KEYS.includes('commitIdentity'), 'the payload key set names the identity (CL-D70)');
});

test('Issue #181 the identity may live only in the operator global config, which isolation would hide', () => {
  // The common case: nothing in the repository, the identity in ~/.gitconfig. An isolated read finds none.
  const repo = repository({ name: null, email: null });
  const env = bareHome();
  fs.writeFileSync(path.join(env.HOME, '.gitconfig'), `[user]\n\tname = ${NAME}\n\temail = ${EMAIL}\n`);
  const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, env);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(captured.data.commitIdentity, { name: NAME, email: EMAIL });
});

test('Issue #181 push_publish refuses a capture that is not a successful operator_capture, a HEAD off its history, or a non-https origin', () => {
  const { pushPublish } = require('../skills/closed-loop-pr/helpers/publish');
  const { repo, captured, created, env } = run();
  stageCorrection(created.path);
  assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
  const refused = (result) => [result.ok, result.error?.code, result.error?.phase];
  assert.deepEqual(refused(pushPublish({ created, captured: { ...captured, ok: false } })), [false, 'invalid_request', 'push_publish'], 'a failed capture');
  assert.deepEqual(refused(pushPublish({ created, captured: { ...captured, operation: 'snapshot' } })), [false, 'invalid_request', 'push_publish'], 'another operation');
  // A HEAD that does not descend from the captured public head is not this run's correction.
  const foreign = { ...captured, data: { ...captured.data, head: 'b'.repeat(40) } };
  assert.deepEqual(refused(pushPublish({ created, captured: foreign })), [false, 'guard_failed', 'push_publish'], 'a HEAD off the captured history');
  // Only the gh helper may authenticate the push, so a remote it cannot serve is refused rather than reached by SSH.
  for (const url of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
    const ssh = { ...captured, data: { ...captured.data, identity: { ...captured.data.identity, originPush: url } } };
    assert.deepEqual(refused(pushPublish({ created, captured: ssh })), [false, 'invalid_request', 'push_publish'], url);
  }
  assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), repo.head, 'nothing was pushed');
});

test('Issue #181 a checkout without an identity stops at preflight, before any gate', () => {
  for (const [label, name, email] of [['no name', null, EMAIL], ['no email', NAME, null], ['neither', null, null]]) {
    const repo = repository({ name, email });
    const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, bareHome());
    assert.deepEqual([captured.ok, captured.error?.code, captured.error?.phase], [false, 'commit_identity_missing', 'operator_capture'], `${label}: ${JSON.stringify(captured)}`);
  }
});

test('Issue #181 an identity Git would rewrite or split is refused, not normalized', () => {
  for (const [label, name, email] of [['angle bracket in name', 'Bad <name>', EMAIL], ['angle bracket in email', NAME, 'bad>@example.invalid'], ['blank name', '   ', EMAIL]]) {
    const repo = repository({ name, email });
    const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, bareHome());
    assert.deepEqual([captured.ok, captured.error?.code], [false, 'commit_identity_invalid'], `${label}: ${JSON.stringify(captured)}`);
  }
});

test('Issue #181 commit_create commits with exactly the captured identity under isolated config', () => {
  // The ambient identity variables Git would otherwise prefer over configuration are set, and must not apply.
  const env = { ...bareHome(), GIT_AUTHOR_NAME: 'Ambient Author', GIT_AUTHOR_EMAIL: 'ambient@example.invalid', GIT_COMMITTER_NAME: 'Ambient Committer', GIT_COMMITTER_EMAIL: 'ambient-c@example.invalid', EMAIL: 'ambient-e@example.invalid' };
  const { repo, captured, created } = run(env);
  stageCorrection(created.path);
  const committed = cli('commit_create', { created, captured, message: MESSAGE }, env);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const head = git(created.path, ['rev-parse', 'HEAD']);
  assert.equal(committed.data.commit, head);
  assert.equal(committed.data.parent, repo.head);
  assert.equal(git(created.path, ['rev-list', '--parents', '-n', '1', 'HEAD']), `${head} ${repo.head}`, 'one commit, sole parent the reviewed head');
  assert.equal(git(created.path, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']), `${NAME} <${EMAIL}>|${NAME} <${EMAIL}>`);
  const verified = cli('message_verify', { cwd: created.path, expected: MESSAGE }, env);
  assert.equal(verified.ok, true, `the stored message is the approved one: ${JSON.stringify(verified)}`);
});

test('Issue #181 commit_create takes no cwd and commits nothing when nothing is staged', () => {
  const { captured, created, env } = run();
  const withCwd = cli('commit_create', { created, captured, message: MESSAGE, cwd: created.path }, env);
  assert.deepEqual([withCwd.ok, withCwd.error?.code, withCwd.error?.message], [false, 'invalid_request', 'unknown request field: cwd'], 'the workspace comes from created, never beside it');
  const before = git(created.path, ['rev-parse', 'HEAD']);
  const empty = cli('commit_create', { created, captured, message: MESSAGE }, env);
  assert.deepEqual([empty.ok, empty.error?.code, empty.error?.phase], [false, 'nothing_staged', 'commit_create'], JSON.stringify(empty));
  assert.equal(git(created.path, ['rev-parse', 'HEAD']), before, 'no commit was made');
  const blank = cli('commit_create', { created, captured, message: '  \n' }, env);
  assert.deepEqual([blank.ok, blank.error?.code, blank.error?.phase], [false, 'invalid_request', 'commit_create'], 'an empty message is refused before Git runs');
});

test('Issue #181 push_publish pushes HEAD to the captured PR branch without force', () => {
  const { repo, captured, created, env } = run();
  stageCorrection(created.path);
  const committed = cli('commit_create', { created, captured, message: MESSAGE }, env);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = cli('push_publish', { created, captured }, env);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.deepEqual(pushed.data, { head: committed.data.commit, ref: 'refs/heads/main' });
  assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), committed.data.commit);
});

test('Issue #181 push_publish never forces over a remote that moved', () => {
  const { repo, captured, created, env } = run();
  // Someone else publishes first.
  fs.writeFileSync(path.join(repo.root, 'other.txt'), 'other\n');
  git(repo.root, ['add', 'other.txt']);
  git(repo.root, ['-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '-m', 'test: other']);
  git(repo.root, ['push', 'origin', 'main']);
  const remote = git(repo.bare, ['rev-parse', 'refs/heads/main']);
  stageCorrection(created.path);
  assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
  const pushed = cli('push_publish', { created, captured }, env);
  assert.deepEqual([pushed.ok, pushed.error?.phase], [false, 'push_publish'], JSON.stringify(pushed));
  assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), remote, 'the remote branch is unchanged');
});

test('Issue #181 gh reads the operator configuration directory on every platform', () => {
  const { ghConfigDir } = require('../skills/closed-loop-pr/helpers/publish');
  assert.equal(ghConfigDir({ GH_CONFIG_DIR: '/cfg/gh' }, 'linux', '/home/o'), '/cfg/gh');
  assert.equal(ghConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/o'), path.join('/xdg', 'gh'));
  assert.equal(ghConfigDir({ APPDATA: 'C:\\Users\\o\\AppData\\Roaming' }, 'win32', 'C:\\Users\\o'), path.join('C:\\Users\\o\\AppData\\Roaming', 'GitHub CLI'));
  assert.equal(ghConfigDir({}, 'linux', '/home/o'), path.join('/home/o', '.config', 'gh'));
});

test('Issue #181 the push names exactly one credential helper, gh, and no force', () => {
  const { pushArgs } = require('../skills/closed-loop-pr/helpers/publish');
  const args = pushArgs('feat/x');
  const helpers = args.flatMap((arg, index) => (args[index - 1] === '-c' && arg.startsWith('credential.helper=') ? [arg] : []));
  assert.equal(helpers.at(-1), 'credential.helper=!gh auth git-credential', 'the named helper is the last one configured');
  assert.equal(helpers.filter((entry) => entry !== 'credential.helper=').length, 1, 'no other helper is configured');
  assert.ok(helpers.indexOf('credential.helper=') < helpers.indexOf('credential.helper=!gh auth git-credential'), 'the inherited list is cleared first');
  assert.deepEqual(args.slice(args.indexOf('push')), ['push', 'origin', 'HEAD:refs/heads/feat/x']);
  assert.ok(!args.some((arg) => /^(?:-f|--force.*|\+.*)$/.test(arg)), 'no force in any form');
});

test('Issue #181 the map, the addendum, and CL-D89 route the commit and push through the packaged operations', () => {
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.match(map, /\| The bounded batch's one normal commit \(CL-D89\) \| `commit_create` \| `created` \(data of `workspace_create`\), `captured` \(envelope of `operator_capture`\), `message` \|/);
  assert.match(map, /\| The bounded batch's one non-force push \(CL-D89\) \| `push_publish` \| `created` \(data of `workspace_create`\), `captured` \(envelope of `operator_capture`\) \|/);
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.match(addendum, /packaged `commit_create`/);
  assert.match(addendum, /packaged `push_publish`/);
  assert.doesNotMatch(addendum, /Push exactly once with `git -C <AUTOFIX_WORKSPACE> push/, 'the push is no longer a composed command');
  const cliText = readText('skills/closed-loop-pr/helpers/cli.js');
  assert.match(cliText, /commit_create: \{ required: \['created', 'captured', 'message'\], optional: \[\] \}/);
  assert.match(cliText, /push_publish: \{ required: \['created', 'captured'\], optional: \[\] \}/);
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D89 — The writer commits and pushes through packaged operations with the operator identity');
  assert.ok(record, 'CL-D89 must exist');
  assert.match(record, /issues\/181#issuecomment-5816104411/, 'the record cites the identity decision');
  assert.match(record, /issues\/181#issuecomment-5822980178/, 'the record cites the push decision');
});

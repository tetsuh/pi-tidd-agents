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
  // CONV-182-HTTPS-USERINFO-AUTH: credentials in an https URL would authenticate the push instead of the named helper.
  for (const url of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'https://token@github.com/owner/repo.git', 'https://user:secret@github.com/owner/repo.git', 'https://:secret@github.com/owner/repo.git']) {
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
  // CONV-182-IDENTITY-WHITESPACE-001: Git strips its "crud" characters (space and controls, and , : ; < > " \\ ') from
  // both ends of each identity field, so an edge that carries one would be committed as a different identity.
  for (const [label, name, email] of [['angle bracket in name', 'Bad <name>', EMAIL], ['angle bracket in email', NAME, 'bad>@example.invalid'], ['blank name', '   ', EMAIL],
    ['leading space in name', ` ${NAME}`, EMAIL], ['trailing space in name', `${NAME} `, EMAIL], ['trailing tab in email', NAME, `${EMAIL}\t`],
    ['leading comma in name', `,${NAME}`, EMAIL], ['trailing quote in name', `${NAME}'`, EMAIL], ['trailing semicolon in email', NAME, `${EMAIL};`], ['leading backslash in name', `\\${NAME}`, EMAIL]]) {
    const repo = repository({ name, email });
    const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, bareHome());
    assert.deepEqual([captured.ok, captured.error?.code], [false, 'commit_identity_invalid'], `${label}: ${JSON.stringify(captured)}`);
  }
});

test('Issue #181 an identity edge Git keeps, such as a trailing dot, is accepted unchanged', () => {
  const repo = repository({ name: 'Initial J.', email: EMAIL });
  const captured = cli('operator_capture', { cwd: repo.root, identity: repo.identity }, bareHome());
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.data.commitIdentity.name, 'Initial J.');
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

test('Issue #181 push_publish checks the push URL the workspace would actually use', () => {
  // CONV-182-PUSH-URL-ACTUAL-001: the capture's URL is only a record; Git pushes through the workspace's origin.
  const { repo, captured, created, env } = run();
  stageCorrection(created.path);
  assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
  // A linked workspace shares the repository's config, so the operator's origin is the workspace's origin.
  git(repo.root, ['remote', 'set-url', '--push', 'origin', 'git@github.com:owner/repo.git']);
  const pushed = cli('push_publish', { created, captured }, env);
  assert.deepEqual([pushed.ok, pushed.error?.code, pushed.error?.phase], [false, 'invalid_request', 'push_publish'], JSON.stringify(pushed));
  assert.match(pushed.error.message, /push URL/);
  // pushInsteadOf does not apply to an explicit pushurl, so the pushurl goes and the rewrite applies to the url.
  git(repo.root, ['config', '--unset', 'remote.origin.pushurl']);
  // A pushInsteadOf rewrite is what Git would use, so it is what is checked.
  git(repo.root, ['config', `url.git@github.com:owner/.pushInsteadOf`, repo.bare]);
  const rewritten = cli('push_publish', { created, captured }, env);
  assert.deepEqual([rewritten.ok, rewritten.error?.code], [false, 'invalid_request'], JSON.stringify(rewritten));
  assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), repo.head, 'nothing was pushed');
});

test('Issue #181 push.followTags in the repository cannot publish a tag beside the branch', () => {
  const { repo, captured, created, env } = run();
  git(repo.root, ['config', 'push.followTags', 'true']);
  stageCorrection(created.path);
  assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
  git(created.path, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'tag', '-a', 'v-leak', '-m', 'leak']);
  const pushed = cli('push_publish', { created, captured }, env);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(git(repo.bare, ['tag', '--list']), '', 'no tag reached the remote');
});

test('Issue #181 repository configuration that would widen or re-authenticate the push is refused before Git runs', () => {
  // CONV-182-PUSH-MIRROR and the rest of its class, swept at once: mirror semantics, a remote helper program, extra
  // HTTP headers (which would authenticate instead of the gh helper), and push options sent to the server.
  for (const [key, value] of [['remote.origin.mirror', 'true'], ['remote.origin.vcs', 'fake'], ['http.extraHeader', 'Authorization: bearer x'],
    ['http.https://github.com/.extraHeader', 'Authorization: bearer x'], ['push.pushOption', 'ci.skip']]) {
    const { repo, captured, created, env } = run();
    stageCorrection(created.path);
    assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
    git(repo.root, ['config', key, value]);
    const pushed = cli('push_publish', { created, captured }, env);
    assert.deepEqual([pushed.ok, pushed.error?.code, pushed.error?.phase], [false, 'invalid_request', 'push_publish'], `${key}: ${JSON.stringify(pushed)}`);
    assert.match(pushed.error.message, /configuration/, key);
    assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), repo.head, `${key}: nothing was pushed`);
  }
});

test('Issue #181 push_publish refuses a remote that would push to more than one URL', () => {
  // CONV-182-PUSHURL-ALL-001: git push origin publishes to every push URL, so every one is checked and there must be one.
  for (const [label, configure] of [
    ['second pushurl', (repo, second) => { git(repo.root, ['config', '--add', 'remote.origin.pushurl', repo.bare]); git(repo.root, ['config', '--add', 'remote.origin.pushurl', second]); }],
    ['second url', (repo, second) => { git(repo.root, ['config', '--add', 'remote.origin.url', second]); }],
  ]) {
    const { repo, captured, created, env } = run();
    const second = temp('i181-second-');
    git(second, ['init', '--bare']);
    stageCorrection(created.path);
    assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
    configure(repo, second);
    const pushed = cli('push_publish', { created, captured }, env);
    assert.deepEqual([pushed.ok, pushed.error?.code, pushed.error?.phase], [false, 'invalid_request', 'push_publish'], `${label}: ${JSON.stringify(pushed)}`);
    assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), repo.head, `${label}: the recorded remote received nothing`);
    assert.equal(git(second, ['for-each-ref']), '', `${label}: the second remote received nothing`);
  }
});

test('Issue #181 the environment cannot redirect, re-scope, or unverify the push', () => {
  // Found by a pre-push sweep against Git 2.43: GIT_CONFIG replaced the configuration the push-time check read while
  // the push still read the repository's; GIT_NAMESPACE moved the pushed ref; the TLS variables let the gh token reach
  // another peer. All are dropped for every Git command, not only the push.
  const { sanitizedEnv } = require('../skills/closed-loop-pr/helpers/process');
  const ambient = { GIT_CONFIG: '/x', GIT_NAMESPACE: 'evil', GIT_SSL_NO_VERIFY: '1', GIT_SSL_CAINFO: '/ca', GIT_HTTP_PROXY_AUTHMETHOD: 'x', GIT_CURL_VERBOSE: '1', CURL_CA_BUNDLE: '/ca', SSL_CERT_FILE: '/ca', SSL_CERT_DIR: '/ca' };
  const env = sanitizedEnv(ambient, 'git');
  for (const key of Object.keys(ambient)) assert.equal(Object.hasOwn(env, key), false, `${key} is dropped`);
  const { repo, captured, created } = run();
  const runEnv = { ...bareHome(), GIT_NAMESPACE: 'evil' };
  stageCorrection(created.path);
  const committed = cli('commit_create', { created, captured, message: MESSAGE }, runEnv);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(cli('push_publish', { created, captured }, runEnv).ok, true);
  assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), committed.data.commit, 'the branch itself moved');
  assert.equal(git(repo.bare, ['for-each-ref', 'refs/namespaces']), '', 'nothing landed under a namespace');
  // GIT_CONFIG pointing at an empty file must not hide push.pushOption from the check.
  const { repo: repo2, captured: captured2, created: created2 } = run();
  const empty = path.join(temp('i181-cfg-'), 'empty');
  fs.writeFileSync(empty, '');
  stageCorrection(created2.path);
  assert.equal(cli('commit_create', { created: created2, captured: captured2, message: MESSAGE }, runEnv).ok, true);
  git(repo2.root, ['config', 'push.pushOption', 'smuggled']);
  const hidden = cli('push_publish', { created: created2, captured: captured2 }, { ...bareHome(), GIT_CONFIG: empty });
  assert.deepEqual([hidden.ok, hidden.error?.code], [false, 'invalid_request'], JSON.stringify(hidden));
  assert.equal(git(repo2.bare, ['rev-parse', 'refs/heads/main']), repo2.head, 'nothing was pushed');
});

test('Issue #181 the push re-checks unsafe and transport configuration set after preflight', () => {
  for (const [key, value] of [['http.sslVerify', 'false'], ['http.curloptResolve', 'github.com:443:127.0.0.1'], ['http.proxy', 'http://127.0.0.1:9'],
    ['credential.helper', 'store'], ['include.path', '/dev/null'], ['remote.origin.proxy', 'http://127.0.0.1:9']]) {
    const { repo, captured, created, env } = run();
    stageCorrection(created.path);
    assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
    git(repo.root, ['config', key, value]);
    const pushed = cli('push_publish', { created, captured }, env);
    assert.deepEqual([pushed.ok, pushed.error?.phase], [false, 'push_publish'], `${key}: ${JSON.stringify(pushed)}`);
    assert.equal(git(repo.bare, ['rev-parse', 'refs/heads/main']), repo.head, `${key}: nothing was pushed`);
  }
  // A receive-pack program set after preflight must not run.
  const { repo, captured, created, env } = run();
  stageCorrection(created.path);
  assert.equal(cli('commit_create', { created, captured, message: MESSAGE }, env).ok, true);
  const marker = path.join(temp('i181-rp-'), 'ran');
  git(repo.root, ['config', 'remote.origin.receivepack', `touch ${marker}; git-receive-pack`]);
  const pushed = cli('push_publish', { created, captured }, env);
  assert.equal(pushed.ok, false, JSON.stringify(pushed));
  assert.equal(fs.existsSync(marker), false, 'the receive-pack program never ran');
});

test('Issue #181 the commit is stored as UTF-8 whatever the repository declares', () => {
  const { repo, captured, created, env } = run();
  git(repo.root, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
  stageCorrection(created.path);
  const committed = cli('commit_create', { created, captured, message: MESSAGE }, env);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.doesNotMatch(git(created.path, ['cat-file', 'commit', 'HEAD']), /^encoding /m, 'no encoding header');
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
  // Configuration cannot widen the push beyond the one branch: no tags, no submodules, no signing (CL-D30's one push).
  assert.deepEqual(args.slice(args.indexOf('push')), ['push', '--no-follow-tags', '--recurse-submodules=no', '--no-signed', 'origin', 'HEAD:refs/heads/feat/x']);
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

test('Issue #181 the helper alarm reset is the one every suite asserts, with room left at the raise', () => {
  // The pre-push review corrections put the helpers at 280,749 bytes; CL-D89 resets the alarm to 290,000.
  assert.match(readText('test/issue-59-helper-surface.test.js'), /const AGGREGATE_SMOKE_ALARM = 290000; \/\/ CL-D89 reviewed reset from 280,000 \(CL-D86\)/);
  assert.match(readText('test/package.test.js'), /helperBytes < 290000/);
  for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith('.test.js') || ['issue-169-post-push-revalidation.test.js', 'issue-181-commit-identity.test.js'].includes(file)) continue;
    assert.equal(readText(`test/${file}`).includes('280000'), false, `${file} must not keep the superseded helper alarm`);
  }
  const dir = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers');
  const bytes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(bytes < 290000, `packaged helpers total ${bytes}`);
  assert.ok(290000 - 280749 > 9000, 'the raise left room, asserted against the measurement it was taken on');
  const boundary = sectionOf(readText('CONTRACT.md'), '## CL-D37 — Bounded helper surface is structural');
  assert.match(boundary, /CL-D89 reset it an eighth time to 290,000 bytes after the review corrections of its own change put the helpers at 280,749, on the same terms\./);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D89 — The writer commits and pushes through packaged operations with the operator identity'), /issues\/181#issuecomment-5834493756/);
});

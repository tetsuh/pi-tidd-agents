'use strict';

// Part 5 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

// Round 2 of PR #199: the target is re-resolved before every gate, the run directory never lies inside a work tree,
// and each resolved role reports its provider, model, and thinking level.
test('Issue #196 a target that moves between gates stops the run BLOCKED before the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const fixture = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  fixture.pull.head.sha = 'f'.repeat(40);
  fs.writeFileSync(t.fixture, JSON.stringify(fixture));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /target moved/);
  assert.equal(s.log.filter((e) => e.operation === 'build_gate_launch').length, 1, 'no second gate was launched');
});

test('Issue #221 the redaction rewrites whole local paths only, whatever HOME says, with placeholders that render', () => {
  // Pre-push sweep: a home of `/r` rewrote the repository `o/r` inside the pull-request URL, because a path matched
  // with no start boundary; an empty HOME left the account's real home unredacted; and `<tmp>`-style placeholders
  // vanish on GitHub as unknown HTML tags.
  let t = setup();
  setFixture(t, { protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } });
  let e = { ...t.e, HOME: '/r' };
  assert.equal(drive(t.start, e).status, 0);
  for (let i = 0; i < 3; i += 1) drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], e);
  let body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.ok(body.includes('Pull request: https://github.com/o/r/pull/7'), 'the URL is untouched');
  assert.ok(body.includes('target: o/r#7'), 'the target is untouched');
  // An empty HOME: the account's own home is still a local path.
  const real = require('node:os').userInfo().homedir;
  t = setup({ config: null });
  e = { ...t.e, HOME: '' };
  drive([...t.start, '--validate', JSON.stringify([[`${real}/no-such-check-221`]])], e);
  body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.equal(body.includes(real), false, `the draft names the account's home: ${body}`);
  assert.ok(body.includes('~/no-such-check-221'), 'the command is still named, from the home placeholder');
  assert.doesNotMatch(body, /<(?:tmp|run-dir|package)>/, 'no placeholder that GitHub would strip as a tag');
  // CONV-223-AC3-BRANCH-PRESERVATION: exact fields are never redacted, even a Git-valid branch that holds a local path.
  t = setup();
  const tmpBranch = `feature@${require('node:os').tmpdir()}/edge`;
  { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.ref = tmpBranch; fs.writeFileSync(t.fixture, JSON.stringify(f)); }
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.ok(body.includes(`head_branch: ${tmpBranch}`), `the branch is published exactly: ${body.match(/head_branch: .*/)?.[0]}`);
  // A brace right before a path is not a boundary that protects anything: one pass never rescans its own output.
  t = setup({ config: null });
  drive([...t.start, '--validate', JSON.stringify([['sh', '-c', `x={a}${real}/no-such-check-221; exit 1`]])], { ...t.e, HOME: '' });
  body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.equal(body.includes(real), false, `a path after a brace is redacted too: ${body}`);
});

// Round 5 of PR #199: a body-only edit between gates stops the next launch (CONV-199-BODY-IDENTITY); a pull request
// that adds `.tidd.json` only at its head is refused, because the file is read at the base (CONV-199-BASE-VALIDATION-CONFIG).
test('Issue #196 a pull request body edited between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.body += '\nEdited.\n'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

// Pre-push sweep: with an empty HOME the path is relative to the working directory, and a removed one is a refusal.
test('Issue #209 an operator configuration relative to a removed working directory is refused, not thrown', () => {
  const { validationCommands } = require('../skills/closed-loop-pr/driver/run');
  const t = setup({ config: null }), gone = temp('i211-cwd-'), saved = { cwd: process.cwd(), home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = ''; delete process.env.XDG_CONFIG_HOME; process.chdir(gone); fs.rmdirSync(gone);
  let result;
  try { result = validationCommands(t.target.root, git(t.target.root, ['rev-parse', 'HEAD']).trim(), { repository: 'o/r' }); } finally {
    process.chdir(saved.cwd); process.env.HOME = saved.home;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
  }
  assert.match(result.problem, /operator configuration .*cannot be read: ENOENT/);
});

// CONV-199-BODY-ID-CLI: the helpers define no body fingerprint, so CL-D93 defines the `github:pr:<N>:body` identity
// itself, as the SHA-256 of the body's LF-normalized UTF-8 bytes, and the record says so instead of claiming every
// correlated value comes from a helper.
test('Issue #196 the pull request body identity is the one CL-D93 defines', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const request = JSON.parse(fs.readFileSync(path.join(t.runDir, fs.readdirSync(t.runDir).find((f) => f.endsWith('-required_evidence_set.request.json'))), 'utf8'));
  const body = request.data.identities.find((x) => x.source === 'github:pr:7:body');
  assert.equal(body.identity, crypto.createHash('sha256').update(Buffer.from('Closes #5.\n', 'utf8')).digest('hex'));
  const record = require('./helpers').readContract();
  assert.match(record, /the `github:pr:<number>:body` identity is the SHA-256 of the body's LF-normalized UTF-8 bytes/);
  assert.doesNotMatch(record, /no value the gate correlates is computed beside the helpers/);
});

// Round 9 of PR #199: runtime roots are judged by status type and by what the root is (CONV-199-CLD54-RUNTIME-ROOT-FILTER);
// the checkout's HEAD is re-read at every boundary (CONV-199-LOCAL-CHECKOUT-REF); every target field is validated
// before the run directory exists (CONV-199-MISSING-HEAD-REPO-ARTIFACTS).
test('Issue #196 a tracked or staged change under a runtime root, or a runtime root that is a symlink, is dirty', () => {
  const staged = setup();
  fs.mkdirSync(path.join(staged.target.root, '.pi')); fs.writeFileSync(path.join(staged.target.root, '.pi', 'x'), 'x');
  git(staged.target.root, ['add', '-f', '.pi/x']);
  assert.notEqual(drive(staged.start, staged.e).status, 0);
  assert.match(state(staged.runDir).reason, /checkout is not clean/);
  const linked = setup();
  fs.symlinkSync(temp('i196-elsewhere-'), path.join(linked.target.root, '.pi'));
  assert.notEqual(drive(linked.start, linked.e).status, 0);
  assert.match(state(linked.runDir).reason, /runtime root \.pi is not a directory/);
  const plain = setup();
  fs.mkdirSync(path.join(plain.target.root, '.pi')); fs.writeFileSync(path.join(plain.target.root, '.pi', 'session'), 'x');
  assert.equal(drive(plain.start, plain.e).status, 0, 'an untracked file in a real runtime root is allowed');
});

// ADV-199-CODEOWNER-APPROVAL: an approval requirement the driver cannot verify from the snapshot (a code owner's
// approval, or an approval after the last push) is named for a human, from branch protection or from a ruleset (a wait until CL-D100).
test('Issue #196 a code-owner or last-push approval requirement is for a human to confirm, even with an approval', () => {
  const approved = (t) => [{ id: 1, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: t.target.head, submitted_at: '2026-09-29T00:00:00Z' }];
  const shapes = [
    { protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true } } },
    { protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_last_push_approval: true } } },
    { rulesets: [{ id: 1, updated_at: '2026-09-29T00:00:00Z', enforcement: 'active', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } }], bypass_actors: [] }] },
  ];
  for (const shape of shapes) {
    const t = setup();
    setFixture(t, { ...shape, reviews: approved(t) });
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'MERGE_READY', `${JSON.stringify(shape)}: ${s.reason}`);
    assert.match(s.operatorActions, /^before merging, a human confirms: (?:branch protection requires required_pull_request_reviews|ruleset 1 can gate the merge \(pull_request\))$/);
  }
});

test('Issue #196 a convergence role found disabled is skipped and reported as convergence: disabled', () => {
  const t = setup();
  const r = drive([...t.start, '--convergence', 'disabled'], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  throughGates(t, 2);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.statusBlock, /^resolved: .*convergence: disabled/m);
  assert.match(s.statusBlock, /^rounds: convergence disabled, /m);
  assert.match(s.reason, /^convergence was disabled; Sol and Terra returned MERGE/, 'the reason names the gates that ran');
  assert.equal(s.invocations.convergence, undefined);
  assert.notEqual(drive([...setup().start, '--convergence', 'off'], t.e).status, 0, 'only the value disabled is accepted');
});

// Round 32 of PR #199: the lock's pid file is written like every other run artifact, exclusively and without
// following a link (CONV-199-LOCK-PID-NOFOLLOW).
test('Issue #196 a link planted at the lock pid path cannot alter its target', () => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const dir = temp('i196-lock-link-'), victim = path.join(temp('i196-victim-'), 'v.txt');
  fs.writeFileSync(victim, 'keep');
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (p, ...rest) => { const made = mkdir(p, ...rest); if (String(p).endsWith(`${path.sep}lock`)) fs.symlinkSync(victim, path.join(p, 'pid')); return made; };
  try { assert.throws(() => new Run(dir)); } finally { fs.mkdirSync = mkdir; }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'the failed construction releases the lock it took');
  assert.ok(new Run(dir).state, 'the run is usable afterwards');
});

// Owner decision https://github.com/tetsuh/pi-tidd-agents/issues/196#issuecomment-5892010180 (the PR #199 cut-off):
// readiness defers to a human what it cannot settle exactly. It never decides whether a ruleset applies or whether
// approvals satisfy it: every ruleset not known disabled that carries a rule other than deletion, non_fast_forward, or
// creation is named for a human, whatever its targeting reads (ADV-199-UNKNOWN-RULESET-SELECTOR included), and so do
// branch protection's review requirements and any other enabled protection setting the driver does not evaluate.
test('Issue #196 a ruleset that can gate a merge, and protection it does not evaluate, are for a human to confirm and never wait', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const head = 'h'.repeat(40);
  const ci = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }];
  const approved = [{ id: 1, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-09-29T00:00:00Z' }];
  const pending = ({ rulesets = [], protection = null }) => { const r = readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: ci, statuses: [], threads: [], reviews: approved,
    policies: { branchProtection: protection, rulesets, organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head); assert.deepEqual([r.pending, r.failed], [[], []], 'nothing waits or fails'); return r.confirm; };
  const ruleset = (rules, extra = {}) => ({ id: 3, name: 'gate', enforcement: 'active', target: 'branch', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules, ...extra });
  assert.deepEqual(pending({ rulesets: [ruleset([{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'creation' }])] }), [], 'rules that never gate a merge');
  assert.deepEqual(pending({ rulesets: [ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }], { enforcement: 'disabled' })] }), [], 'a disabled ruleset');
  for (const [name, set] of [['met required check', ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }])],
    ['met approval', ruleset([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }])], ['unknown rule', ruleset([{ type: 'future_rule' }])], ['unreadable rules', ruleset(undefined)],
    ['unknown selector', ruleset([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/unreported' }] } }], { conditions: { ref_name: { include: [{ future: 'all-branches' }], exclude: [] } } })],
    ['excluded by its targeting', ruleset([{ type: 'pull_request' }], { conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } } })]]) {
    assert.match(pending({ rulesets: [set] }).join(';'), /^ruleset gate can gate the merge \(/, name);
  }
  assert.match(pending({ protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } }).join(';'), /^branch protection requires required_pull_request_reviews$/, 'met protection approvals');
  assert.match(pending({ protection: { required_signatures: { enabled: true } } }).join(';'), /required_signatures/, 'an enabled protection setting');
  assert.deepEqual(pending({ protection: { required_signatures: { enabled: false }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, required_status_checks: { contexts: ['ci'], checks: [] } } }), [], 'settings that are off or evaluated');
});

// Round 40 of PR #199: branch protection's `strict` (the head must be up to date with the base) is a requirement the
// driver does not settle, so it is named for a human (CONV-199-STRICT-REQUIRED-CHECKS); and a role's thinking level is
// the runner's own `thinking` field, with a model suffix only as a fallback (CONV-199-ROLE-THINKING-STATUS).
test('Issue #196 strict required checks are for a human to confirm, and a role reports the runner\'s thinking field', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const { roleLabel } = require('../skills/closed-loop-pr/driver/run');
  const head = 'h'.repeat(40);
  const ci = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }];
  const pending = (rsc) => { const r = readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: ci, statuses: [], threads: [], reviews: [], policies: { branchProtection: { required_status_checks: rsc }, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head); assert.deepEqual(r.pending, []); return r.confirm; };
  assert.match(pending({ strict: true, contexts: ['ci'], checks: [] }).join(';'), /^branch protection requires required_status_checks\.strict \(the head up to date with the base\)$/);
  assert.deepEqual(pending({ strict: false, contexts: ['ci'], checks: [] }), []);
  assert.equal(roleLabel('r', 'p/m', 'high'), 'r p/m:high');
  assert.equal(roleLabel('r', 'p/m:max', 'max'), 'r p/m:max');
  assert.equal(roleLabel('r', 'p/m:max'), 'r p/m:max');
  assert.equal(roleLabel('r', 'p/m'), 'r p/m:unreported');
});

// The pre-push sweep after round 40: GitHub's own mergeability, which any reader sees, settles what an unreadable
// protection or ruleset would hide (a 404 on protection reads as unprotected to a non-admin), a branch behind its base,
// and a merge conflict; and a bot's request for changes blocks like a human's.
test('Issue #196 readiness waits unless GitHub reports the pull request mergeable or blocked, and a bot\'s request for changes blocks', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const head = 'h'.repeat(40);
  const run = (pull, reviews = []) => readiness({ pull, after: { repository: 'o/r', baseBranch: 'main' }, checks: [], statuses: [], threads: [], reviews, policies: { branchProtection: false, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, head);
  for (const state of ['clean', 'unstable', 'has_hooks']) assert.deepEqual(run({ mergeable: true, mergeable_state: state }).pending, [], state);
  for (const state of ['behind', 'dirty', 'unknown', 'draft', null]) assert.match(run({ mergeable: state === 'dirty' ? false : null, mergeable_state: state }).pending.join(';'), /mergeable/, String(state));
  // `blocked` is a requirement only a human or GitHub settles: named for a human, never waited for (CL-D100).
  const blocked = run({ mergeable: null, mergeable_state: 'blocked' });
  assert.deepEqual([blocked.pending, blocked.confirm], [[], ['GitHub reports the pull request mergeable_state blocked']]);
  // Owner decision UNREADABLE-PROTECTION-BY-MERGEABILITY on PR #227: a protection read that answers 404 arrives as
  // `false`, for no protection and for a token that may not read it alike. GitHub's mergeability settles it: `blocked`
  // is named above, and a mergeable state leaves nothing to name.
  for (const state of ['clean', 'unstable', 'has_hooks']) { const r = run({ mergeable: true, mergeable_state: state }); assert.deepEqual([r.pending, r.failed, r.confirm], [[], [], []], `unreadable protection, ${state}`); }
  const bot = [{ id: 1, user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-09-29T00:00:00Z' }];
  assert.match(run({ mergeable: true, mergeable_state: 'clean' }, bot).failed.join(';'), /changes requested by coderabbitai\[bot\]/);
});

// Round 41 of PR #199: required linear history constrains how the pull request is merged, which the driver does not
// settle, so it is named for a human; only settings that never gate a merge are settled (ADV-199-LINEAR-HISTORY-PROTECTION).
test('Issue #196 required linear history is for a human to confirm, and only non-gating protection settings are settled', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const pending = (bp) => { const r = readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks: [], statuses: [], threads: [], reviews: [], policies: { branchProtection: bp, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } }, 'h'.repeat(40)); assert.deepEqual(r.pending, []); return r.confirm; };
  assert.match(pending({ required_linear_history: { enabled: true } }).join(';'), /^branch protection requires required_linear_history$/);
  for (const key of ['lock_branch', 'restrictions', 'required_signatures', 'a_future_setting']) assert.match(pending({ [key]: { enabled: true } }).join(';'), new RegExp(key), key);
  assert.deepEqual(pending({ url: 'u', enforce_admins: { enabled: true }, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true }, block_creations: { enabled: true }, allow_fork_syncing: { enabled: true }, required_conversation_resolution: { enabled: true } }), []);
});

// Round 42 of PR #199: every command that opens a run judges its directory as start does, so result, resume, and
// status never create a lock or write inside a Git work tree (CONV-199-RUN-DIR-OPEN-CHECK).
test('Issue #196 result, resume, and status refuse a run directory inside a work tree before writing anything', () => {
  const t = setup();
  const inside = path.join(t.target.root, 'run-inside');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'state.json'), JSON.stringify({ seq: 0, log: [], state: 'WAITING_EXTERNAL_REVIEW', pending: { gate: 'convergence' } }));
  for (const args of [['result', '--run-dir', inside, '--run-id', 'x'], ['resume', '--run-dir', inside], ['status', '--run-dir', inside]]) {
    const r = drive(args, t.e);
    assert.notEqual(r.status, 0, args[0]);
    assert.match(r.stderr, /inside a Git work tree/, args[0]);
    assert.equal(fs.existsSync(path.join(inside, 'lock')), false, `${args[0]} took no lock`);
  }
});

// The pre-push sweep after round 42: the driver's own Git calls carry the helpers' safe configuration, so a hook the
// checkout's config names never runs (core.fsmonitor set by the head's validation), and a given run directory must be
// the operator's own and closed to other writers.
test('Issue #196 the driver\'s Git never runs a configured fsmonitor, and a run directory others can write is refused', () => {
  const t = setup();
  const marker = path.join(temp('i196-hook-'), 'ran');
  const hook = path.join(temp('i196-hookbin-'), 'fsmonitor.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  git(t.target.root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['git', 'config', 'core.fsmonitor', hook]] }));
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  drive(t.start, t.e);
  assert.equal(fs.existsSync(marker), false, 'the configured fsmonitor hook never ran');
  const open = setup();
  fs.mkdirSync(open.runDir, { recursive: true }); fs.chmodSync(open.runDir, 0o777);
  const r = drive(open.start, open.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /writable by others/);
});

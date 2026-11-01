'use strict';

// Issue #328 (CL-D128): any change of the external snapshot cleared every gate verdict and reran convergence, although a
// gate payload carries the snapshot only as its fingerprint. On tetsuh/sitometron PR #114, 11 of 33 kept runs reran
// convergence on an unchanged head because check runs completed and a `Bot` posted a quality-gate comment; in 6 the
// rerun on the same inputs turned a `MERGE` into `FIX BEFORE MERGE`. Owner choice A: only the fields a gate can act on
// (reviews, review threads, inline comments, conversation comments not by a `Bot`, the pull request's fields apart from
// its mergeability) clear verdicts, a body or target change still stopping the run `BLOCKED` (CL-D27); the final
// policy still reads a snapshot taken at final readiness.
//
// TDD provenance: behavioural RED — a completed check between convergence and Sol reruns convergence.
const { test, assert, fs, drive, setup, state, setFixture, throughGates, nextRequest, fakeGate, prComment } = require('./issue-196-review-driver.fixtures.js');
const autofix = require('./issue-196-autofix-driver.fixtures.js');
const { readText } = require('./helpers');

const BOT = (id) => prComment(id, { user: { login: 'sonarqubecloud[bot]', type: 'Bot' }, author_association: 'NONE', body: 'Quality Gate passed' });
const result = (t, options) => drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, options)], t.e);
const pullPatch = (t, change) => { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); return { pull: { ...f.pull, ...change } }; };

test('Issue #328 AC4 a check completing and a Bot comment between convergence and Sol do not rerun convergence', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { checkStatus: 'completed', prComments: [BOT(1)] });
  const r = result(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `${state(t.runDir).state} ${state(t.runDir).reason}`);
  const s = state(t.runDir);
  assert.equal(s.verdicts.convergence, 'MERGE', 'the convergence verdict stands');
  assert.equal(s.invocations.convergence, 1);
  throughGates(t, 2);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.equal(state(t.runDir).invocations.convergence, 1, 'convergence ran once');
});

test('Issue #328 AC1 a policy-only or mergeability-only change, before a later gate or at final readiness, clears nothing', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, pullPatch(t, { mergeable_state: 'unstable' }));
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  result(t);
  // Between Terra's launch and final readiness the checks complete and a Bot comments again.
  setFixture(t, { prComments: [BOT(2)], checkStatus: 'completed' });
  const r = result(t);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.equal(state(t.runDir).invocations.convergence, 1);
});

test('Issue #328 AC3 the final policy still reads the snapshot taken at final readiness', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { checkStatus: 'in_progress' });
  result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.equal(s.invocations.convergence, 1, 'the pending check waits; it reruns nothing');
});

test('Issue #328 AC2 a run saved before the digest existed still reruns convergence on a new human comment', () => {
  // ADV sweep before the first push: an older state has no `reviewSnapshot`, so its first read compares the full
  // fingerprint once instead of reporting no change.
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW');
  const file = require('node:path').join(t.runDir, 'state.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.reviewSnapshot; fs.writeFileSync(file, JSON.stringify(saved));
  setFixture(t, { prComments: [prComment(7)] });
  const r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `${state(t.runDir).state} ${state(t.runDir).reason}`);
});

// Each excluded field on its own, in both drivers, at every point the snapshot is read after the first gate: before Sol,
// before Terra, and at final readiness. The field takes its variant, then its baseline, then its variant again, so each
// read sees a change from the one before. CONV-331-AC1-EXCLUSION-TESTS (round 1), CONV-331-AC1-DRIVER-EXCLUSION-COVERAGE
// (round 4) and CONV-331-AC1-BRANCH-POLICY-TEST (round 5) each named one field this table now holds.
const RULESET = (id) => [{ id, updated_at: '2026-09-29T00:00:00Z', enforcement: 'evaluate', target: 'branch', rules: [], bypass_actors: [] }];
const STATUS = (context) => [{ id: 11, context, state: 'success', target_url: null, description: 'ok', creator: { login: context === 'CodeRabbit' ? 'coderabbitai[bot]' : 'ci' }, created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }];
// [label, variant, baseline, fixture before the run starts]
const EXCLUDED = [
  ['check runs', { checkStatus: 'completed' }, { checkStatus: 'in_progress' }, { checkStatus: 'in_progress' }],
  ['statuses', { statuses: STATUS('lint') }, { statuses: [] }],
  ['check suites', { checkSuites: [{ id: 12, status: 'completed', conclusion: 'success', head_sha: 'x', app: { slug: 'ci' }, created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }] }, { checkSuites: [] }],
  ['annotations', { annotations: [{ path: 'a.js', start_line: 1, end_line: 1, annotation_level: 'warning', title: 't', message: 'm', raw_details: '' }] }, { annotations: [] }],
  ['rulesets', { rulesets: RULESET(13) }, { rulesets: [] }],
  ['branch protection', { protection: { url: 'p', required_status_checks: { strict: true, contexts: ['ci'] } } }, { protection: null }],
  ['organization rulesets', { orgRulesets: RULESET(14) }, { orgRulesets: [] }, { ownerType: 'Organization' }],
  ['default branch', { defaultBranch: 'trunk' }, { defaultBranch: 'main' }],
  ['external review', { statuses: STATUS('CodeRabbit') }, { statuses: [] }],
  ['Bot comments', { prComments: [BOT(1)] }, { prComments: [] }],
  ['reactions', { prComments: [prComment(3, { reactions: { url: 'x', total_count: 1, '+1': 1 } })] }, { prComments: [prComment(3)] }, { prComments: [prComment(3)] }],
  ['pull.mergeable', { mergeable: false }, { mergeable: true }],
  ['pull.mergeable_state', { mergeableState: 'unstable' }, { mergeableState: 'clean' }],
];
// The review-only fake serves the pull request whole, so the mergeability knobs go into it.
const reviewSet = (t, { mergeable, mergeableState, ...rest }) => setFixture(t, { ...rest, ...(mergeable === undefined && mergeableState === undefined ? {} : pullPatch(t, { ...(mergeable === undefined ? {} : { mergeable }), ...(mergeableState === undefined ? {} : { mergeable_state: mergeableState }) })) });
const DRIVERS = {
  'review-only': {
    start(initial) { const t = setup(); if (initial) reviewSet(t, initial); assert.equal(drive(t.start, t.e).status, 0); return t; },
    set: reviewSet, step: (t) => nextRequest(result(t).stdout)?.agent,
    check(t, where) { const s = state(t.runDir); assert.equal(s.verdicts.convergence, 'MERGE', where); assert.equal(s.invocations.convergence, 1, where); return s; },
    cleared: (t) => state(t.runDir).verdicts.convergence === undefined,
  },
  autofix: {
    start(initial) { const a = autofix.setup(); if (initial) autofix.setFixture(a.bin, initial); assert.equal(autofix.drive(a.start, a.env).status, 0); return a; },
    set: (a, patch) => autofix.setFixture(a.bin, patch), step: (a) => autofix.nextRequest(autofix.result(a).stdout)?.agent,
    check(a, where) { const s = autofix.state(a.runDir); assert.ok(s.gateLog.every((g) => g.cleared === undefined), where); assert.equal(s.gateLog.filter((g) => g.gate === 'convergence').length, 1, where); return s; },
    cleared: (a) => Boolean(autofix.state(a.runDir).gateLog.find((g) => g.gate === 'convergence').cleared),
  },
};
test('Issue #328 AC1 each excluded field changing alone before Sol, before Terra and at final readiness clears nothing in either driver', () => {
  for (const [label, variant, baseline, initial] of EXCLUDED) {
    for (const [name, d] of Object.entries(DRIVERS)) {
      const t = d.start(initial);
      d.set(t, variant);
      assert.equal(d.step(t), 'tidd-adversarial-reviewer', `${name}, ${label}, before Sol`);
      d.check(t, `${name}, ${label}, before Sol`);
      d.set(t, baseline);
      assert.equal(d.step(t), 'tidd-safety-reviewer', `${name}, ${label}, before Terra`);
      d.check(t, `${name}, ${label}, before Terra`);
      d.set(t, variant);
      assert.equal(d.step(t), undefined, `${name}, ${label}, at final readiness`);
      const s = d.check(t, `${name}, ${label}, at final readiness`);
      assert.equal(s.state, 'MERGE_READY', `${name}, ${label}: ${s.reason}`);
    }
  }
});

// AC2 in full, in both drivers: a new or edited review, review thread or trusted conversation comment between
// convergence and Sol still clears the convergence verdict and reruns convergence.
const REVIEW = (body) => ({ id: 21, user: { login: 'h', type: 'User' }, author_association: 'MEMBER', state: 'COMMENTED', body, commit_id: 'x', html_url: 'r21', submitted_at: '2026-09-29T00:00:00Z' });
const THREAD = (body) => ({ id: 't9', isResolved: false, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: 'c9', databaseId: 9, url: 'u', body, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } }], pageInfo: { endCursor: null, hasNextPage: false } } });
// [label, fixture before the run starts, change]
const REVIEWED = [
  ['a new review', undefined, { reviews: [REVIEW('please change this')] }],
  ['an edited review', { reviews: [REVIEW('looks fine')] }, { reviews: [REVIEW('please change this')] }],
  ['a new review thread', undefined, { threads: [THREAD('please change this')] }],
  ['an edited review thread', { threads: [THREAD('nit')] }, { threads: [THREAD('please change this')] }],
  ['a new trusted comment', undefined, { prComments: [prComment(3)] }],
  ['an edited trusted comment', { prComments: [prComment(3)] }, { prComments: [prComment(3, { body: 'please change this', updated_at: '2026-09-30T00:00:00Z' })] }],
];
test('Issue #328 AC2 a new or edited review, review thread or trusted comment between gates reruns convergence in either driver', () => {
  for (const [label, initial, change] of REVIEWED) {
    for (const [name, d] of Object.entries(DRIVERS)) {
      const t = d.start(initial);
      d.set(t, change);
      assert.equal(d.step(t), 'tidd-convergence-reviewer', `${name}, ${label}`);
      assert.ok(d.cleared(t), `${name}, ${label}: the convergence verdict is cleared`);
    }
  }
});

// Every field the snapshot reader returns is either hashed or named by a row of EXCLUDED, so a field added to the
// snapshot later fails here until it is classified (CONV-331-AC1-BRANCH-POLICY-TEST). `completeness` holds flags the
// reader sets itself, which no fixture input changes, so it has no row.
const HASHED = ['before', 'after', 'pull', 'comments', 'reviews', 'inline', 'threads'];
const ROW = {
  checks: 'check runs', statuses: 'statuses', checkSuites: 'check suites', annotations: 'annotations',
  'policies.branchProtection': 'branch protection', 'policies.rulesets': 'rulesets', 'policies.organizationRulesets': 'organization rulesets',
  'policies.defaultBranch': 'default branch', 'policies.checks': 'check runs', 'policies.externalReview': 'external review',
  'pull.mergeable': 'pull.mergeable', 'pull.mergeable_state': 'pull.mergeable_state',
};
test('Issue #328 AC1 every snapshot field is hashed or named by a row of the exclusion table', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const file = fs.readdirSync(t.runDir).filter((f) => /-snapshot\.result\.json$/.test(f)).sort().pop();
  const snapshot = JSON.parse(fs.readFileSync(require('node:path').join(t.runDir, file), 'utf8')).data;
  const fields = [...Object.keys(snapshot).filter((k) => k !== 'policies'), ...Object.keys(snapshot.policies).map((k) => `policies.${k}`), ...['mergeable', 'mergeable_state'].filter((k) => k in snapshot.pull).map((k) => `pull.${k}`)];
  const labels = new Set(EXCLUDED.map(([label]) => label));
  for (const field of fields) assert.ok(HASHED.includes(field) || field === 'completeness' || labels.has(ROW[field]), `unclassified snapshot field ${field}`);
  for (const field of Object.keys(ROW)) assert.ok(fields.includes(field), `classified field ${field} is no longer in the snapshot`);
});

// CONV-331-PR-BODY-FAILSTOP (PR #331 round 6): of the pull request's own fields, a body or target change stops the run
// `BLOCKED` (CL-D27) rather than rerunning convergence; the remaining ones, such as the title, rerun it.
test('Issue #328 AC5 the record\'s pull-request clause: a title change reruns convergence, a body change stops BLOCKED first, in both drivers', () => {
  for (const [field, expect] of [['title', 'rerun'], ['body', 'stop']]) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const pull = JSON.parse(fs.readFileSync(t.fixture, 'utf8')).pull;
    setFixture(t, pullPatch(t, { [field]: `${pull[field]}Edited.\n` }));
    const next = nextRequest(result(t).stdout)?.agent, s = state(t.runDir);
    if (expect === 'rerun') assert.equal(next, 'tidd-convergence-reviewer', `review-only, ${field}: ${s.state} ${s.reason}`);
    else { assert.equal(s.state, 'BLOCKED', `review-only, ${field}`); assert.match(s.reason, /body changed/); }
    const a = autofix.setup();
    assert.equal(autofix.drive(a.start, a.env).status, 0);
    autofix.setFixture(a.bin, { [field]: `${autofix.readFixture(a.bin)[field] || 't'}Edited.\n` });
    const r = autofix.result(a), sa = autofix.state(a.runDir);
    if (expect === 'rerun') assert.equal(autofix.nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `autofix, ${field}: ${sa.state} ${sa.reason}`);
    else { assert.equal(sa.state, 'BLOCKED', `autofix, ${field}`); assert.match(sa.reason, /body changed/); }
  }
});

test('Issue #328 AC5 the record, the index, the shared contract and CL-D62 agree', () => {
  const record = readText('contract/CL-D128.md');
  assert.match(record, /^## CL-D128 — /m);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D128.md](contract/CL-D128.md) — '), 'the index lists CL-D128');
  assert.match(record, /still records the full snapshot fingerprint/);
  // CONV-331-AC3-BLOCKED-STATE (PR #331 round 2): the final policy is unchanged, so `blocked` is still named for a human.
  assert.match(record, /a check, status, thread or `mergeable_state` the final policy fails or waits on stops the run as before, and `mergeable_state` `blocked` is still named for a human to confirm before merging \(CL-D100\)/);
  assert.doesNotMatch(record, /a non-mergeable state stops the run/);
  // CONV-331-PR-BODY-FAILSTOP (PR #331 round 6): the record and the shared contract name the body and target stop.
  assert.match(record, /A change in the pull request's body or target \(its base and head, state or draft\) still stops the run `BLOCKED` \(CL-D27\), and a fresh run is needed\./);
  assert.doesNotMatch(record, /A change in the target brackets, the pull request apart from/);
  // CONV-331-AC1-STALE-SNAPSHOT-COMMENTS (PR #331 round 7): the driver's own comment on clearing names the review digest.
  const phases = readText('skills/closed-loop-pr/driver/phases.js');
  assert.ok(phases.includes('// A change in the snapshot\'s review digest (CL-D128) invalidates every gate verdict so far: the log keeps them,'), 'markCleared names the review digest');
  assert.ok(!phases.includes('// A snapshot change invalidates every gate verdict so far'), 'no comment says any snapshot change clears the verdicts');
  // The records and docs that stated the earlier rule point forward, and no driver comment calls any new external
  // evidence a restart.
  assert.ok(readText('contract/CL-D93.md').includes('CL-D128 later narrowed the snapshot change that invalidates to the fields a gate can act on, so a check or status changing state clears no verdict (#328).'), 'CL-D93 points forward');
  assert.ok(readText('contract/CL-D96.md').includes('the snapshot evidence with new review evidence (CL-D128) restarting the sequence'), 'CL-D96 names the review evidence');
  assert.ok(readText('contract/CL-D100.md').includes("A change of the snapshot still reruns the gates (CL-D93) where CL-D128 lets it, and since #328 a provider's state alone, like any status, clears no verdict"), 'CL-D100 takes the provider state out');
  assert.ok(readText('README.md').includes('with its own round budget (a new snapshot fingerprint reruns it only when the fields a gate can act on changed, CL-D128)'), 'the README narrows the convergence trigger');
  const titles = JSON.parse(readText('contract/CL-D30.clauses.json')).clauses.map((c) => c.title);
  assert.ok(titles.includes('A changed external snapshot, in its review digest since CL-D128, invalidates every verdict and restarts the gates on the same head'), 'the CL-D30 clause title names the digest');
  for (const file of ['phases.js', 'review.js', 'autofix.js']) {
    const text = readText(`skills/closed-loop-pr/driver/${file}`);
    for (const stale of ['carries external evidence the previous one did not', 'new external evidence reruns convergence', 'New external evidence restarts the sequence']) assert.ok(!text.includes(stale), `${file} still says "${stale}"`);
  }
  assert.match(readText('skills/closed-loop-shared/references/gate-contract.md'), /a change in the pull request's body or target still stopping the run `BLOCKED` \(CL-D27\)[^\n]*\(CL-D128\)/);
  assert.match(readText('skills/closed-loop-shared/references/gate-contract.md'), /a snapshot change counts only in the fields a gate can act on[^\n]*\(CL-D128\)/);
  assert.match(readText('contract/CL-D62.md'), /CL-D128 later/);
  const clauses = JSON.parse(readText('contract/CL-D128.clauses.json')).clauses;
  assert.ok(clauses.some((c) => c.files.includes('skills/closed-loop-pr/driver/phases.js')), 'a clause pins the digest in phases.js');
});

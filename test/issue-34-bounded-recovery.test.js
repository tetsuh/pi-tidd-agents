'use strict';

// Issue #34 / CL-D39: exact PR autofix gains one bounded recovery for a deterministic local
// tooling failure before any Luna task exists. Two properties matter and are pinned here:
// the recovery is confined to the pre-writer region, and it is expressed only in the mode
// reference that already owns retry behaviour, so no shared prose forks and no shared
// sentence gains a mode exception.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, sectionOf, cliSchemas } = require('./helpers');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const RECORDS = 'skills/closed-loop-shared/references/records.md';
const REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const ISSUE_SKILL = 'skills/closed-loop-issue/SKILL.md';
const CLI = 'skills/closed-loop-pr/helpers/cli.js';
const CONTRACT = 'CONTRACT.md';
const RECOVERY_HEADING = '### Bounded pre-writer recovery (CL-D39)';


test('Issue #34 the recovery is bounded to the pre-writer region', () => {
  const section = sectionOf(readText(PR_AUTOFIX), RECOVERY_HEADING);
  assert.ok(section, `${PR_AUTOFIX} must own the bounded recovery rule`);
  assert.match(section, /One recovery is permitted for a deterministic local tooling failure/);
  assert.match(section, /no Luna task, commit, push, or reply exists/);
  // DEC-PR65-CLD39-WORKSPACE-MUTATION-001: workspace creation is authorized Git administration
  // that AUTOFIX_WORKSPACE@H presupposes, so the guard exempts exactly those setup effects.
  assert.match(section, /other than the already-authorized `workspace_create` setup effects, namely the external run root, linked-worktree registration or clone, and receipt/);
  assert.match(section, /no correction, publication, provider, target, or operator mutation exists/);
  assert.match(section, /`OPERATOR_CHECKOUT_UNCHANGED@O` and `AUTOFIX_WORKSPACE@H` are freshly re-proved/);
  // CLEAN@H was retired by Issue #42 and is not a live invariant; it must not return.
  assert.doesNotMatch(section, /CLEAN@H/, 'the recovery must bind to live invariants only');
  assert.match(section, /the budget is exactly one per key/);
  // The key vocabulary is grounded in the CLI operation names and the file's own phase model.
  assert.match(section, /The operation part is the packaged CLI operation that failed, so each `fingerprint_\*` operation is its own key/);
  assert.match(section, /The phase part is `preflight`, `gate_launch`, `gate_result`, or `normalize` before any edit, and the guard or step name from Luna's batch sequence after/);
  assert.match(section, /a replacement failure is the second failure of that key and is terminal/);
  assert.match(section, /Recovery never launches a second writer, repeats a provider mutation, or re-enters a phase after Luna starts/);

  // The mapping must be closed over every Issue #34 failure, each with a canonical key, a
  // prevalidated replacement, an outcome, and explicit evidence handling.
  assert.match(section, /one canonical `operation@phase` key/);
  assert.match(section, /The replacement retains the key/);
  assert.match(section, /preserves evidence already proved unchanged and invalidates only the failed operation's own output/);

  const rows = section.split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Failure \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.equal(rows.length, 5, `the mapping must cover all five Issue #34 failures, found ${rows.length}`);
  for (const row of rows) assert.equal(row.length, 5, `each row needs failure, key, replacement, outcome, evidence: ${row.join(' | ')}`);
  const byKey = new Map(rows.map((row) => [row[1], row]));
  assert.deepEqual([...byKey.keys()].sort(), [
    '`envelope_read@normalize`', '`fingerprint_<op>@normalize`', '`manifest_compare@AFTER_STAGING`',
    '`report_verify@normalize`', '`validation_harness@focused_validation`',
  ], 'every failure needs its own canonical key');
  // Both post-writer failures stay terminal with no replacement: the manifest assertion, and
  // the harness error, which in the shipped phase model only occurs inside Luna's focused
  // validation or a gate child.
  const terminalKeys = ['`manifest_compare@AFTER_STAGING`', '`validation_harness@focused_validation`'];
  for (const key of terminalKeys) {
    const row = byKey.get(key);
    assert.equal(row[2], 'none', `${key} has no prevalidated replacement`);
    assert.equal(row[3], 'terminal', `${key} must be terminal`);
  }
  // SOL-65-RECOVERY-SPEC: the report replacement is selected by the envelope's own
  // `operation` field, which every packaged envelope carries, so it is deterministic.
  assert.match(byKey.get('`report_verify@normalize`')[2], /the operation named in the report envelope's own `operation` field, read directly as `envelope_read`/);
  for (const [key, row] of byKey) {
    if (terminalKeys.includes(key)) continue;
    assert.equal(row[3], 'recoverable', `${key} should be recoverable`);
    assert.notEqual(row[2], 'none', `${key} needs a concrete prevalidated replacement`);
    assert.ok(row[4].length > 0, `${key} must state its evidence handling`);
  }
  // Every key not listed is terminal, swept by the file's own phase tokens.
  assert.match(section, /Every key not listed is terminal/);
  for (const token of ['`preflight` and `gate_launch`', '`gate_result`', '`normalize`', 'from the first Luna task onward']) {
    assert.ok(section.includes(token), `the terminal sweep must name ${token}`);
  }
});

test('Issue #34 the stop rule keeps its wording and names the single exception', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop, except for the CL-D39 recovery defined above\./);
  // The invocation-map sentence must not contradict the recovery it now defers to.
  assert.match(text, /no retry beyond the CL-D39 recovery defined above/);
  // The recovery section really is above the stop rule.
  assert.ok(text.indexOf('### Bounded pre-writer recovery (CL-D39)') < text.indexOf('except for the CL-D39 recovery defined above'));
});

test('Issue #34 no shared prose forks and no shared sentence gains a mode exception', () => {
  // The shared layer already delegates retry behaviour, so the mode reference can own the
  // recovery outright. These pins fail if a future change instead conditionalises shared text.
  const shared = readText(GATE_CONTRACT);
  assert.match(shared, /Ordinary workflow-specific retry and fail-stop behavior belongs to the selected owning workflow or mode reference; shared policy does not grant a retry, publication, or mutation\./,
    'the shared delegation is what makes the mode-local rule possible');
  assert.match(shared, /Workflow-specific candidate, retry, extension, and resume boundaries remain authoritative in their owning files\./);
  assert.match(shared, /Tool, provider, startup, stale-target, and unparsable-verdict failures \*\*do not consume a round\*\*\./,
    'shared round accounting must stay compatible with a counter-free recovery');

  for (const file of [GATE_CONTRACT, RECORDS]) {
    const text = readText(file);
    assert.doesNotMatch(text, /CL-D39/, `${file} must not carry the mode-specific recovery decision`);
    assert.doesNotMatch(text, /exact autofix[^.]*recover/i, `${file} must not gain an autofix exception`);
  }
  // The other two modes keep their own rule, untouched and unqualified.
  for (const file of [REVIEW_ONLY, ISSUE_SKILL]) {
    const text = readText(file);
    assert.match(text, /retry the invocation once, and if it fails again report `BLOCKED`/, `${file} must keep its existing single retry`);
    assert.doesNotMatch(text, /CL-D39/, `${file} must not be conditionalised by the autofix decision`);
  }
});

test('Issue #34 CL-D39 records the recovery and the no-fork basis', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Exact autofix gains one bounded pre-writer recovery');
  assert.ok(section, 'CL-D39 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-recovery, CL-D39-baseline$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option B for exact PR `autofix`/);
  assert.match(section, /Issue and PR review-only keep their existing single malformed-verdict retry unchanged/);
  assert.match(section, /No shared prose changes, and no shared sentence gains a mode exception/);
  assert.match(section, /Removing the mode-ownership statement from the shared gate contract invalidates the no-fork basis recorded here/);
  // The corrected evidence stays recorded: the narrowing is partial, not closing.
  assert.match(section, /rejects unknown fields without preventing selection of the wrong known field/);
  assert.match(section, /all accept an `oid` so a same-typed cross-domain mix-up remains reachable/);
  // The retired invariant and the funded baseline are both recorded.
  assert.match(section, /`CLEAN@H` is not used because Issue #42 retired it/);
  assert.equal((section.match(/CLEAN@H/g) || []).length, 1, 'CLEAN@H may appear only in the sentence retiring it');
  assert.match(section, /`OPERATOR_CHECKOUT_UNCHANGED@O` and `AUTOFIX_WORKSPACE@H` are freshly re-proved/);
  assert.match(section, /that row is terminal here and its structural removal stays with #64/);
  assert.match(section, /raises the six-file authority baseline from 112,000 to 116,000 bytes/);
  assert.match(section, /the shortfall is funded by the raise rather than by a trim/);
  // The recorded measurement is revision-qualified so it cannot read as a running total.
  assert.match(section, /measured 112,720 bytes at `f7f3ff9`, when the raise was decided/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-baseline', 'CL-D39-recovery', 'CL-D39-stop'],
  );
});

test('Issue #34 user-facing and CL-D30 summaries acknowledge the bounded exception', () => {
  assert.match(readText('README.md'), /apart from the one bounded pre-writer recovery CL-D39 defines, it has no retry, resume/);
  assert.match(sectionOf(readText(CONTRACT), '## CL-D30 — Exact PR autofix publishes one bounded correction per public head'), /CL-D39 later adds one bounded pre-writer recovery and nothing else/);
});

test('Issue #34 the partial-narrowing evidence in the record still matches the code', () => {
  // CL-D39 cites these as reasons the case is not closed; if the code changes, the record
  // must be revisited rather than silently drifting.
  const sharingOid = Object.entries(cliSchemas()).filter(([name, fields]) => name.startsWith('fingerprint_') && fields.length === 1 && fields[0] === 'oid').map(([name]) => name).sort();
  assert.deepEqual(sharingOid, ['fingerprint_pr_base', 'fingerprint_pr_head', 'fingerprint_pr_tree'],
    'the record cites these three as sharing an oid input; a change here invalidates that rationale');
  assert.match(readText(PR_AUTOFIX), /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/);
});

// Executable decision model. Review-driven regression: the CL-D39 rule expressed as code so the
// prose is checked for decidability, not only for presence. Outcomes per key are parsed from
// the shipped mapping so prose drift fails here; the eight guards and the per-key budget are
// the rule's own conditions. This models the parent's decision; it is not a packaged helper.
// `noMutationAttempted` means no mutation beyond the enumerated workspace_create setup effects.
const GUARDS = ['noMutationAttempted', 'noLunaTask', 'operatorUnchanged', 'workspaceVerified', 'identityUnchanged', 'fingerprintsUnchanged', 'deterministicLocal', 'replacementPrevalidated'];
const allGuardsTrue = () => Object.fromEntries(GUARDS.map((guard) => [guard, true]));
function mappingOutcomes() {
  const section = sectionOf(readText(PR_AUTOFIX), RECOVERY_HEADING);
  const rows = section.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Failure \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  // `fingerprint_<op>` expands only to the fingerprint operations the packaged CLI actually
  // exposes. An unrestricted wildcard let an invented operation reach recovery; the contract
  // says the operation part is the packaged CLI operation that failed, so bind it to the table.
  const fingerprintOps = Object.keys(cliSchemas()).filter((name) => name.startsWith('fingerprint_'));
  assert.ok(fingerprintOps.length > 0, 'the CLI must expose fingerprint operations');
  const expand = (key) => key.replace(/`/g, '').replace('fingerprint_<op>', `(?:${fingerprintOps.join('|')})`);
  return rows.map(([, key, , outcome]) => ({ pattern: new RegExp('^' + expand(key) + '$'), outcome }));
}
// Setup effects are modelled explicitly so the exemption is decidable, not implied.
const SETUP_EFFECTS = ['externalRunRoot', 'linkedWorktreeOrClone', 'receipt'];
function mutationGuard(events) {
  // true when every attempted mutation is an authorized setup effect
  return events.every((event) => SETUP_EFFECTS.includes(event));
}
function decide(key, guards, ledger) {
  // An operation the packaged CLI does not expose cannot carry a recoverable key at all.
  const [operation] = key.split('@');
  const knownOperation = Object.hasOwn(cliSchemas(), operation) || ['envelope_read', 'report_verify', 'validation_harness', 'manifest_compare'].includes(operation);
  if (!knownOperation) return 'terminal';
  const row = mappingOutcomes().find((entry) => entry.pattern.test(key));
  if (!row || row.outcome !== 'recoverable') return 'terminal';
  if (GUARDS.some((guard) => guards[guard] !== true)) return 'terminal';
  const used = ledger.get(key) || 0;
  if (used >= 1) return 'terminal';
  ledger.set(key, used + 1);
  return 'recover';
}

const FAILURE_KEYS = {
  envelope: 'envelope_read@normalize',
  report: 'report_verify@normalize',
  fingerprintBase: 'fingerprint_pr_base@normalize',
  fingerprintTree: 'fingerprint_pr_tree@normalize',
  harness: 'validation_harness@focused_validation',
  manifest: 'manifest_compare@AFTER_STAGING',
};

test('Issue #34 decision model: permitted and forbidden siblings for every mapped failure', () => {
  const cases = [
    ['envelope read, all guards, first time', FAILURE_KEYS.envelope, {}, 'recover'],
    ['report verify, all guards, first time', FAILURE_KEYS.report, {}, 'recover'],
    ['fingerprint pr_base, all guards, first time', FAILURE_KEYS.fingerprintBase, {}, 'recover'],
    ['harness failure is post-writer', FAILURE_KEYS.harness, {}, 'terminal'],
    ['manifest assertion is post-writer', FAILURE_KEYS.manifest, {}, 'terminal'],
    ['unlisted key: gate result malformed verdict', 'gate_result_validate@gate_result', {}, 'terminal'],
    ['unlisted key: writability at preflight', 'writability@preflight', {}, 'terminal'],
  ];
  for (const [name, key, override, expected] of cases) {
    assert.equal(decide(key, { ...allGuardsTrue(), ...override }, new Map()), expected, name);
  }
});

test('Issue #34 decision model: each guard independently false is terminal', () => {
  for (const guard of GUARDS) {
    for (const key of [FAILURE_KEYS.envelope, FAILURE_KEYS.report, FAILURE_KEYS.fingerprintBase]) {
      const guards = { ...allGuardsTrue(), [guard]: false };
      assert.equal(decide(key, guards, new Map()), 'terminal', `${key} with ${guard}=false must be terminal`);
    }
  }
});

test('Issue #34 decision model: per-key budget is isolated and a second failure of the same key is terminal', () => {
  const ledger = new Map();
  assert.equal(decide(FAILURE_KEYS.fingerprintBase, allGuardsTrue(), ledger), 'recover');
  // replacement failure = second failure of the same key
  assert.equal(decide(FAILURE_KEYS.fingerprintBase, allGuardsTrue(), ledger), 'terminal', 'replacement failure must be terminal');
  // a different fingerprint operation is a different key and keeps its own budget
  assert.equal(decide(FAILURE_KEYS.fingerprintTree, allGuardsTrue(), ledger), 'recover', 'budget is per key, not per family');
  assert.equal(decide(FAILURE_KEYS.envelope, allGuardsTrue(), ledger), 'recover');
  assert.equal(decide(FAILURE_KEYS.envelope, allGuardsTrue(), ledger), 'terminal');
  // the budget is never refreshed by a different key succeeding
  assert.equal(decide(FAILURE_KEYS.fingerprintBase, allGuardsTrue(), ledger), 'terminal');
});

test('Issue #34 decision model: an invented fingerprint operation is terminal and consumes no budget', () => {
  const ledger = new Map();
  for (const key of ['fingerprint_not_packaged@normalize', 'fingerprint_@normalize', 'fingerprint_pr_base_extra@normalize']) {
    assert.equal(decide(key, allGuardsTrue(), ledger), 'terminal', `${key} names no packaged operation and must be terminal`);
  }
  assert.equal(ledger.size, 0, 'an unknown operation must not consume budget');
  // and every real fingerprint operation still reaches recovery once
  for (const operation of Object.keys(cliSchemas()).filter((name) => name.startsWith('fingerprint_'))) {
    assert.equal(decide(`${operation}@normalize`, allGuardsTrue(), new Map()), 'recover', `${operation} is a packaged operation and must be recoverable`);
  }
});

test('Issue #34 decision model: workspace setup effects do not block recovery but any other mutation does', () => {
  // post-workspace: the workspace exists, so its authorized setup effects have happened
  assert.equal(mutationGuard(['externalRunRoot', 'linkedWorktreeOrClone', 'receipt']), true);
  assert.equal(decide(FAILURE_KEYS.envelope, { ...allGuardsTrue(), noMutationAttempted: mutationGuard(SETUP_EFFECTS), workspaceVerified: true }, new Map()), 'recover',
    'a freshly verified workspace with only setup effects must still allow recovery');
  for (const mutation of ['commit', 'push', 'reply', 'providerMutation', 'targetMutation', 'operatorMutation', 'correctionEdit']) {
    const guards = { ...allGuardsTrue(), noMutationAttempted: mutationGuard([...SETUP_EFFECTS, mutation]) };
    assert.equal(decide(FAILURE_KEYS.envelope, guards, new Map()), 'terminal', `${mutation} must keep recovery unreachable`);
  }
});

test('Issue #34 decision model: a budget entry does not change a terminal row into a recoverable one', () => {
  const ledger = new Map();
  assert.equal(decide(FAILURE_KEYS.manifest, allGuardsTrue(), ledger), 'terminal');
  assert.equal(ledger.size, 0, 'terminal outcomes must not consume budget');
});

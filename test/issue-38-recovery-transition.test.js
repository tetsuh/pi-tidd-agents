'use strict';

// Issue #38 remainder after CL-D39 (Issue #34): the recovery's place in the deterministic
// action order, and the #38 acceptance vectors 3, 4, 6, and 7 in executable, per-field form.
// Review-driven regression: this models the parent's decision; it is not a packaged helper.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const RECOVERY_HEADING = '### Bounded pre-writer recovery (CL-D39)';

test('Issue #38 the action order states where recovery sits and that safety precedes it', () => {
  const text = readText(PR_AUTOFIX);
  const order = text.match(/Apply this deterministic action order[^\n]*/);
  assert.ok(order, 'the deterministic action order clause must exist');
  assert.match(order[0], /The CL-D39 recovery is evaluated only after target movement, lifecycle, identity, and fingerprint checks and gate correlation and result validation have passed/);
  assert.match(order[0], /and before any no-progress or limit accounting, owner decision, final policy, or reply step/);
  assert.match(order[0], /a safety or identity failure always takes precedence over recovery eligibility/);
});

// --- executable model, per-field -------------------------------------------------------
// Identity fields the issue enumerates, and the fingerprints CL-D9 defines.
const IDENTITY = ['repository', 'number', 'baseOid', 'headRepository', 'headBranch', 'headOid', 'lifecycle'];
const FINGERPRINTS = ['issue_spec', 'pr_tree', 'pr_diff', 'pr_commits', 'pr_head', 'snapshot'];
// Cleanliness conditions the issue enumerates for vector 4.
const CLEANLINESS = ['trackedClean', 'indexClean', 'runtimeRootsSafe', 'noOutsideUntracked'];
const MUTATIONS = ['writerLaunched', 'stagingAttempted', 'commitAttempted', 'pushAttempted', 'replyAttempted', 'summaryAttempted', 'providerMutationAttempted'];

function mapping() {
  const section = sectionOf(readText(PR_AUTOFIX), RECOVERY_HEADING);
  return section.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Failure \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .map(([, key, , outcome, evidence]) => ({ key: key.replace(/`/g, ''), outcome, evidence }));
}
const baseState = () => ({
  expected: { identity: Object.fromEntries(IDENTITY.map((f) => [f, `${f}-0`])), fingerprints: Object.fromEntries(FINGERPRINTS.map((f) => [f, `${f}-0`])) },
  actual: { identity: Object.fromEntries(IDENTITY.map((f) => [f, `${f}-0`])), fingerprints: Object.fromEntries(FINGERPRINTS.map((f) => [f, `${f}-0`])) },
  cleanliness: Object.fromEntries(CLEANLINESS.map((c) => [c, true])),
  mutations: Object.fromEntries(MUTATIONS.map((m) => [m, false])),
  providerLaterUnchanged: true,
  deterministicLocal: true,
  replacementPrevalidated: true,
});
function decide(key, state, ledger) {
  const rows = mapping();
  const row = rows.find((r) => new RegExp('^' + r.key.replace('fingerprint_<op>', 'fingerprint_[a-z_]+') + '$').test(key));
  const terminal = (reason) => ({ outcome: 'terminal', reason, evidence: row ? row.evidence : 'unlisted key' });
  if (!row || row.outcome !== 'recoverable') return terminal('not a recoverable key');
  for (const f of IDENTITY) if (state.actual.identity[f] !== state.expected.identity[f]) return terminal(`identity:${f}`);
  for (const f of FINGERPRINTS) if (state.actual.fingerprints[f] !== state.expected.fingerprints[f]) return terminal(`fingerprint:${f}`);
  for (const c of CLEANLINESS) if (state.cleanliness[c] !== true) return terminal(`cleanliness:${c}`);
  // an attempt rejects recovery even when the provider later appears unchanged (vector 5)
  for (const m of MUTATIONS) if (state.mutations[m] === true) return terminal(`mutation:${m}`);
  if (!state.deterministicLocal) return terminal('not deterministic local');
  if (!state.replacementPrevalidated) return terminal('replacement not prevalidated');
  if ((ledger.get(key) || 0) >= 1) return terminal('budget exhausted');
  ledger.set(key, 1);
  return { outcome: 'recover', evidence: row.evidence };
}
const RECOVERABLE = ['envelope_read@normalize', 'report_verify@normalize', 'fingerprint_pr_diff@normalize'];

test('Issue #38 vector 3: any changed identity field or fingerprint rejects recovery, field by field', () => {
  for (const key of RECOVERABLE) {
    assert.equal(decide(key, baseState(), new Map()).outcome, 'recover', `${key} must recover when everything is equal`);
    for (const f of IDENTITY) {
      const s = baseState(); s.actual.identity[f] = `${f}-moved`;
      const r = decide(key, s, new Map()); assert.equal(r.outcome, 'terminal', `${key}: changed ${f} must reject`); assert.equal(r.reason, `identity:${f}`);
    }
    for (const f of FINGERPRINTS) {
      const s = baseState(); s.actual.fingerprints[f] = `${f}-moved`;
      const r = decide(key, s, new Map()); assert.equal(r.outcome, 'terminal', `${key}: changed ${f} must reject`); assert.equal(r.reason, `fingerprint:${f}`);
    }
  }
});

test('Issue #38 vector 4: each cleanliness condition independently rejects recovery', () => {
  for (const key of RECOVERABLE) for (const c of CLEANLINESS) {
    const s = baseState(); s.cleanliness[c] = false;
    const r = decide(key, s, new Map()); assert.equal(r.outcome, 'terminal', `${key}: ${c}=false must reject`); assert.equal(r.reason, `cleanliness:${c}`);
  }
});

test('Issue #38 vector 5: any mutation attempt rejects recovery even when the provider later appears unchanged', () => {
  for (const key of RECOVERABLE) for (const m of MUTATIONS) {
    const s = baseState(); s.mutations[m] = true; s.providerLaterUnchanged = true;
    const r = decide(key, s, new Map()); assert.equal(r.outcome, 'terminal', `${key}: ${m} must reject`); assert.equal(r.reason, `mutation:${m}`);
  }
});

test('Issue #38 vector 6: the remaining terminal families stay terminal', () => {
  for (const key of ['snapshot@gate_launch', 'writability@preflight', 'gate_result_validate@gate_result', 'operator_capture@preflight', 'workspace_verify@preflight', 'workspace_create@preflight', 'validation_harness@focused_validation', 'manifest_compare@AFTER_STAGING', 'luna@BEFORE_COMMIT']) {
    const r = decide(key, baseState(), new Map());
    assert.equal(r.outcome, 'terminal', `${key} must be terminal`);
  }
});

test('Issue #38 vector 7: a recovery names what is preserved and what is invalidated; terminal rows preserve everything', () => {
  for (const key of RECOVERABLE) {
    const r = decide(key, baseState(), new Map());
    assert.equal(r.outcome, 'recover');
    assert.match(r.evidence, /preserved/, `${key} must name preserved evidence`);
    assert.match(r.evidence, /invalidated/, `${key} must name invalidated evidence`);
  }
  for (const key of ['validation_harness@focused_validation', 'manifest_compare@AFTER_STAGING']) {
    const r = decide(key, baseState(), new Map());
    assert.equal(r.outcome, 'terminal'); assert.match(r.evidence, /all evidence stands/);
  }
});

test('Issue #38 vector 2: the same failure a second time is terminal and nothing is reused', () => {
  const ledger = new Map();
  assert.equal(decide('envelope_read@normalize', baseState(), ledger).outcome, 'recover');
  const again = decide('envelope_read@normalize', baseState(), ledger);
  assert.equal(again.outcome, 'terminal'); assert.equal(again.reason, 'budget exhausted');
});

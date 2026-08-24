'use strict';

// Issue #50 — per-PR aggregate accounting derived from the target's own evidence.
//
// TDD provenance: before implementation the focused command below produced 0 passes and 6
// failures. The authority-presence scenario is pre-implementation compile/contract RED; the
// derivation, ceiling, base-movement, fail-closed, and CLI-routing scenarios are
// pre-implementation behavioral RED. That local output is not claimed as repository-preserved
// or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const CONTRACT = readText('CONTRACT.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');

const BASE = 'a'.repeat(40);
function oid(index) { return String(index).padStart(2, '0').repeat(20); }
function commits(count, from = 1) {
  return Array.from({ length: count }, (unused, index) => ({ oid: oid(index + from) }));
}
function accounting(overrides = {}) {
  return helpers.deriveAccounting({ repository: 'tetsuh/pi-tidd-agents', number: 50, base: BASE, commits: commits(3), ...overrides });
}
function cli(request) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify(request), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}

test('Issue #50 authority bounds one PR across fresh runs without durable state', () => {
  const section = sectionOf(AUTOFIX, '### Per-PR aggregate accounting (CL-D41)');
  assert.ok(section, 'autofix must own a CL-D41 aggregate-accounting section');
  assert.match(section, /`\(repository, pull-request number, base OID\)`/);
  assert.match(section, /derived from the target's own evidence at each snapshot, never stored/);
  assert.match(section, /base movement starts a new key/);
  assert.match(section, /at most 10 correction commits/);
  assert.match(section, /`WAITING_FOR_OWNER\(reason=owner_decision_required\)`/);
  assert.match(section, /never a silent fresh start/);
  assert.match(section, /conservative superset of the run-scoped successful-push counter/);
  assert.match(section, /the run-scoped 15 gate invocations, 5 successful correction pushes, and third-observation no-progress stop are unchanged/);
  assert.match(section, /`pr_accounting`/);
  // The parts that cannot be derived must be stated as absent rather than implied.
  assert.match(section, /carries no gate-invocation count, settled ledger, or prior `MERGE` head across runs/);

  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.match(map, /\| `pr_accounting` \| `repository`, `number`, `base`, `commits` \|/);

  const decision = sectionOf(CONTRACT, '## CL-D41 — Exact autofix bounds one pull request across fresh runs');
  assert.ok(decision, 'CONTRACT.md must record CL-D41');
  for (const field of ['*Decision ID:* CL-D41', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D41 record must carry ${field}`);
  }
  assert.match(decision, /no durable workflow state/);
  assert.match(decision, /Issue #40/);
});

test('Issue #50 accounting derives the key and the correction-commit count', () => {
  const result = accounting();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation, 'pr_accounting');
  assert.equal(result.data.accountingKey, `tetsuh/pi-tidd-agents#50@${BASE}`);
  assert.equal(result.data.correctionCommits, 3);
  assert.equal(result.data.ceiling, 10);
  assert.equal(result.data.ceilingReached, false);
  assert.equal(accounting({ commits: [] }).data.correctionCommits, 0);
});

test('Issue #50 base movement starts a new accounting key', () => {
  const moved = 'b'.repeat(40);
  const before = accounting().data.accountingKey;
  const after = accounting({ base: moved }).data.accountingKey;
  assert.notEqual(before, after);
  assert.equal(after, `tetsuh/pi-tidd-agents#50@${moved}`);
  // A different pull request in the same repository at the same base is a different key.
  assert.notEqual(accounting({ number: 51 }).data.accountingKey, before);
});

test('Issue #50 the aggregate ceiling reaches at ten and stays reached above it', () => {
  assert.equal(accounting({ commits: commits(9) }).data.ceilingReached, false);
  assert.equal(accounting({ commits: commits(10) }).data.ceilingReached, true);
  assert.equal(accounting({ commits: commits(23) }).data.ceilingReached, true);
  assert.equal(accounting({ commits: commits(23) }).data.correctionCommits, 23);
});

test('Issue #50 accounting is fail-closed on incomplete or contradictory input', () => {
  const cases = [
    ['repository', { repository: 'pi-tidd-agents' }],
    ['repository', { repository: '' }],
    ['number', { number: 0 }],
    ['number', { number: 1.5 }],
    ['number', { number: '50' }],
    ['base', { base: 'a'.repeat(39) }],
    ['base', { base: 'A'.repeat(40) }],
    ['commits', { commits: {} }],
    ['commits', { commits: [{}] }],
    ['commits', { commits: [{ oid: 'zz' }] }],
    ['commits', { commits: [{ oid: oid(1) }, { oid: oid(1) }] }],
    ['commits', { commits: [{ oid: BASE }] }],
  ];
  for (const [field, override] of cases) {
    const result = accounting(override);
    assert.equal(result.ok, false, `${field}: ${JSON.stringify(override)} must fail closed`);
    assert.equal(result.error.code, 'invalid_accounting');
    assert.equal(result.error.phase, 'pr_accounting');
  }
});

test('Issue #50 the packaged CLI routes pr_accounting under JSON v1', () => {
  const ok = cli({ version: 1, operation: 'pr_accounting', data: { repository: 'tetsuh/pi-tidd-agents', number: 48, base: BASE, commits: commits(23) } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.status, 0);
  assert.equal(ok.data.correctionCommits, 23);
  assert.equal(ok.data.ceilingReached, true);

  for (const data of [
    { repository: 'tetsuh/pi-tidd-agents', number: 48, base: BASE, commits: [], extra: 1 },
    { repository: 'tetsuh/pi-tidd-agents', number: 48, base: BASE },
  ]) {
    const rejected = cli({ version: 1, operation: 'pr_accounting', data });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error.code, 'invalid_request');
    assert.notEqual(rejected.status, 0);
  }

  // A well-formed request that the operation itself rejects still exits nonzero.
  const derived = cli({ version: 1, operation: 'pr_accounting', data: { repository: 'tetsuh', number: 48, base: BASE, commits: [] } });
  assert.equal(derived.error.code, 'invalid_accounting');
  assert.notEqual(derived.status, 0);
});

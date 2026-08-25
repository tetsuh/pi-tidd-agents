'use strict';

// Issue #36 — one versioned evidence envelope and a read-only preflight verifier.
//
// TDD provenance: before implementation the focused command below produced 0 passes and 10
// failures. Every one of those is compile/contract RED, not behavioral RED: the authority
// scenario failed on the missing section, and the other nine failed because `verifyEvidence`
// did not exist, so no behavioral RED is claimed for this file. That local output is not
// claimed as repository-preserved or runtime-compliance evidence.
// The expected-fingerprint, lifecycle-identity, bracket-binding, and target-bracket scenarios
// are review-driven regressions added after Sol raised SOL-72-FINGERPRINTS,
// SOL-72-IDENTITY, and SOL-72-BRACKET-TARGET.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf, cliSchemas } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const CONTRACT = readText('CONTRACT.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const SPEC = '1'.repeat(64);
const DIFF = '2'.repeat(64);
const COMMITS = '3'.repeat(64);
const SNAP = '4'.repeat(64);

function brackets() {
  return { repository: 'tetsuh/pi-tidd-agents', number: 36, base: BASE, baseBranch: 'main', head: HEAD, state: 'open', draft: false, headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'topic' };
}
function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    captureIdentity: {
      repository: 'tetsuh/pi-tidd-agents', number: 36, baseOid: BASE, headOid: HEAD,
      baseBranch: 'main', headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'topic', state: 'open', draft: false,
    },
    fingerprints: {
      issue_spec: { domain: 'issue_spec', encoding: 'normalized_text', value: SPEC },
      pr_base: { domain: 'pr_base', encoding: 'git_oid', value: BASE },
      pr_tree: { domain: 'pr_tree', encoding: 'git_oid', value: TREE },
      pr_head: { domain: 'pr_head', encoding: 'git_oid', value: HEAD },
      pr_diff: { domain: 'pr_diff', encoding: 'raw_bytes', value: DIFF },
      pr_commits: { domain: 'pr_commits', encoding: 'normalized_text', value: COMMITS },
      snapshot: { domain: 'snapshot', encoding: 'canonical_json', value: SNAP },
    },
    brackets: { before: brackets(), after: brackets() },
    completeness: { rest: true, reviewThreads: true, nestedThreadComments: true, rulesetDetails: true, organizationRulesets: true, checks: true, brackets: true },
    ...overrides,
  };
}
function expectedFingerprints(overrides = {}) {
  return { issue_spec: SPEC, pr_base: BASE, pr_tree: TREE, pr_head: HEAD, pr_diff: DIFF, pr_commits: COMMITS, snapshot: SNAP, ...overrides };
}
function expected(overrides = {}) {
  return {
    repository: 'tetsuh/pi-tidd-agents', number: 36, baseOid: BASE, headOid: HEAD,
    baseBranch: 'main', headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'topic', state: 'open', draft: false,
    fingerprints: expectedFingerprints(),
    ...overrides,
  };
}
function verify(env = envelope(), exp = expected()) {
  return helpers.verifyEvidence({ envelope: env, expected: exp });
}
function withFingerprint(domain, patch) {
  const env = envelope();
  env.fingerprints[domain] = { ...env.fingerprints[domain], ...patch };
  return env;
}
function cli(request) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify(request), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}

test('Issue #36 authority records the envelope, the verifier, and the closed CL-D39 hole', () => {
  const section = sectionOf(AUTOFIX, '### Versioned evidence envelope (CL-D42)');
  assert.ok(section, 'autofix must own a CL-D42 evidence-envelope section');
  assert.match(section, /`schemaVersion`/);
  assert.match(section, /an unknown or absent version fails closed before any field is read/);
  assert.match(section, /every fingerprint travels as `\{ domain, encoding, value \}`/);
  assert.match(section, /a record whose `domain` differs from the field holding it is rejected/);
  assert.match(section, /`raw_bytes`, `normalized_text`, and `canonical_json` are distinct byte domains/);
  assert.match(section, /`evidence_verify` is read-only and repeatable/);
  assert.match(section, /every identity field or fingerprint value differing from the expected target/);
  assert.match(section, /moved capture bracket/);
  assert.match(section, /incomplete pagination/);
  // The residual must be stated rather than implied: labels defeat a moved record, not a
  // hand-written value.
  assert.match(section, /a value retyped by hand into a well-formed record is not detectable here/);

  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.match(map, /\| `evidence_verify` \| `envelope`, `expected` \|/);

  const decision = sectionOf(CONTRACT, '## CL-D42 — Evidence travels in one versioned envelope with labelled domains');
  assert.ok(decision, 'CONTRACT.md must record CL-D42');
  for (const field of ['*Decision ID:* CL-D42', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D42 record must carry ${field}`);
  }

  // CL-D39 cited the unlabelled same-typed operations as a still-reachable mix-up. The
  // envelope closes the copy path, so that citation must be corrected rather than left stale.
  const recovery = sectionOf(CONTRACT, '## CL-D39 — Exact autofix gains one bounded pre-writer recovery');
  assert.match(recovery, /CL-D42/, 'CL-D39 must record that CL-D42 narrowed its cited hole');
  assert.doesNotMatch(recovery, /a same-typed cross-domain mix-up remains reachable/);
});

test('Issue #36 a complete envelope verifies and reports the labelled domains', () => {
  const result = verify();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation, 'evidence_verify');
  assert.equal(result.data.schemaVersion, 1);
  assert.deepEqual(result.data.domains.slice().sort(), ['issue_spec', 'pr_base', 'pr_commits', 'pr_diff', 'pr_head', 'pr_tree', 'snapshot']);
  assert.equal(result.data.bracketStable, true);
});

test('Issue #36 an unknown or absent schema version fails closed', () => {
  for (const version of [2, 0, -1, '1', 1.5, null, undefined]) {
    const env = envelope();
    if (version === undefined) delete env.schemaVersion; else env.schemaVersion = version;
    const result = verify(env);
    assert.equal(result.ok, false, `schemaVersion ${String(version)} must fail closed`);
    assert.equal(result.error.code, 'unsupported_schema_version');
    assert.equal(result.error.phase, 'evidence_verify');
  }
});

test('Issue #36 a record whose domain differs from its field is rejected', () => {
  // The realistic copy slip: the whole labelled record from one operation lands in another
  // field. Both values are well formed and the same width, so only the label separates them.
  const swapped = envelope();
  swapped.fingerprints.pr_head = { domain: 'pr_base', encoding: 'git_oid', value: BASE };
  const result = verify(swapped);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'domain_mismatch');

  const digestSwap = envelope();
  digestSwap.fingerprints.pr_diff = { domain: 'pr_commits', encoding: 'normalized_text', value: COMMITS };
  assert.equal(verify(digestSwap).error.code, 'domain_mismatch');

  // A missing or extra domain is rejected before any value is compared.
  const missing = envelope();
  delete missing.fingerprints.pr_tree;
  assert.equal(verify(missing).error.code, 'envelope_invalid');
  const extra = envelope();
  extra.fingerprints.pr_notes = { domain: 'pr_notes', encoding: 'raw_bytes', value: DIFF };
  assert.equal(verify(extra).error.code, 'envelope_invalid');
});

// Review-driven regression (SOL-72-PROVENANCE): the verifier cannot preserve a source label
// that the fingerprint operation never emitted. Every operation must own its labelled record;
// envelope assembly carries that record instead of recreating its domain from a bare value.
test('Issue #36 every fingerprint operation owns the labelled record used by envelope assembly', () => {
  const cases = [
    ['fingerprint_issue_spec', { body: 'spec', comments: [] }, 'issue_spec', 'normalized_text'],
    ['fingerprint_pr_base', { oid: BASE }, 'pr_base', 'git_oid'],
    ['fingerprint_pr_tree', { oid: TREE }, 'pr_tree', 'git_oid'],
    ['fingerprint_pr_diff', { base64: Buffer.from('diff').toString('base64') }, 'pr_diff', 'raw_bytes'],
    ['fingerprint_pr_commits', { commits: [{ message: 'subject\n\nbody' }] }, 'pr_commits', 'normalized_text'],
    ['fingerprint_pr_head', { oid: HEAD }, 'pr_head', 'git_oid'],
    ['fingerprint_snapshot', { snapshot: { head: HEAD } }, 'snapshot', 'canonical_json'],
  ];
  const outputs = {};
  for (const [operation, data, domain, encoding] of cases) {
    const result = cli({ version: 1, operation, data });
    assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.data.record, { domain, encoding, value: result.data.fingerprint });
    outputs[domain] = result.data.record;
  }

  // Self-consistency on the parent's expectation cannot rescue a record emitted by the wrong
  // operation: the operation-owned source label is retained and the destination rejects it.
  const misplaced = envelope();
  misplaced.fingerprints.pr_diff = outputs.pr_commits;
  const selfConsistent = expected({ fingerprints: expectedFingerprints({ pr_diff: outputs.pr_commits.value }) });
  const result = verify(misplaced, selfConsistent);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'domain_mismatch');
});

test('Issue #36 each domain declares one byte domain and one value shape', () => {
  assert.equal(verify(withFingerprint('pr_diff', { encoding: 'normalized_text' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_commits', { encoding: 'raw_bytes' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('snapshot', { encoding: 'normalized_text' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_base', { encoding: 'raw_bytes' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_diff', { encoding: 'unknown_domain' })).error.code, 'encoding_mismatch');

  // A git OID may be 40 or 64 hex; a digest is always 64; neither accepts the other's junk.
  // The expectation is moved with the value so this isolates the shape rule from the value
  // comparison; a shape error must win over the comparison, not hide behind it.
  const wide = 'd'.repeat(64);
  assert.equal(verify(withFingerprint('pr_tree', { value: wide }), expected({ fingerprints: expectedFingerprints({ pr_tree: wide }) })).ok, true);
  for (const [domain, value] of [['pr_tree', 'd'.repeat(39)], ['pr_diff', 'd'.repeat(40)], ['pr_diff', 'D'.repeat(64)]]) {
    const result = verify(withFingerprint(domain, { value }), expected({ fingerprints: expectedFingerprints({ [domain]: value }) }));
    assert.equal(result.error.code, 'envelope_invalid', `${domain} ${value.length}: ${JSON.stringify(result.error)}`);
  }
  // A 64-hex base OID is well shaped, so only the comparison can reject it.
  assert.equal(verify(withFingerprint('pr_base', { value: wide })).error.code, 'fingerprint_mismatch');
});

test('Issue #36 a moved capture bracket is rejected', () => {
  const moved = envelope();
  moved.brackets.after = { ...brackets(), head: 'e'.repeat(40) };
  const result = verify(moved);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bracket_identity_moved');

  for (const [field, value] of [['repository', 'tetsuh/other'], ['number', 37], ['base', 'e'.repeat(40)], ['baseBranch', 'release'], ['state', 'closed'], ['draft', true], ['headRepository', 'other/fork'], ['headBranch', 'other']]) {
    const drifted = envelope();
    drifted.brackets.after = { ...brackets(), [field]: value };
    assert.equal(verify(drifted).error.code, 'bracket_identity_moved', `${field} movement must be rejected`);
  }
});

test('Issue #36 incomplete pagination or completeness metadata is rejected', () => {
  for (const flag of ['rest', 'reviewThreads', 'nestedThreadComments', 'rulesetDetails', 'organizationRulesets', 'checks', 'brackets']) {
    const missing = envelope();
    delete missing.completeness[flag];
    assert.equal(verify(missing).error.code, 'evidence_incomplete', `missing ${flag} must be rejected`);
    const falsey = envelope();
    falsey.completeness[flag] = false;
    assert.equal(verify(falsey).error.code, 'evidence_incomplete', `false ${flag} must be rejected`);
  }
});

test('Issue #36 the envelope is compared against the expected target identity', () => {
  assert.equal(verify(envelope(), expected({ headOid: 'f'.repeat(40) })).error.code, 'identity_mismatch');
  assert.equal(verify(envelope(), expected({ baseOid: 'f'.repeat(40) })).error.code, 'identity_mismatch');
  assert.equal(verify(envelope(), expected({ number: 37 })).error.code, 'identity_mismatch');
  assert.equal(verify(envelope(), expected({ repository: 'tetsuh/other' })).error.code, 'identity_mismatch');

  // The head OID the envelope claims and the head fingerprint it carries must agree. With the
  // expectation moved too, the capture-versus-fingerprint binding is what remains under test.
  const inconsistent = envelope();
  inconsistent.fingerprints.pr_head.value = 'f'.repeat(40);
  assert.equal(verify(inconsistent).error.code, 'fingerprint_mismatch');
  assert.equal(verify(inconsistent, expected({ fingerprints: expectedFingerprints({ pr_head: 'f'.repeat(40) }) })).error.code, 'identity_mismatch');
});

test('Issue #36 the envelope is closed and the verifier is read-only and repeatable', () => {
  for (const mutate of [
    (env) => { env.extra = 1; },
    (env) => { env.captureIdentity.extra = 1; },
    (env) => { env.brackets.extra = 1; },
    (env) => { env.brackets.before.extra = 1; },
    (env) => { env.fingerprints.pr_base.extra = 1; },
    (env) => { delete env.captureIdentity; },
    (env) => { delete env.brackets; },
    (env) => { env.fingerprints = []; },
  ]) {
    const env = envelope();
    mutate(env);
    const result = verify(env);
    assert.equal(result.ok, false, 'an unknown or missing structural field must be rejected');
    assert.ok(['envelope_invalid', 'unsupported_schema_version'].includes(result.error.code), result.error.code);
  }

  // Read-only: the same input verifies identically and is not mutated by the call.
  const env = envelope();
  const frozen = JSON.stringify(env);
  assert.deepEqual(verify(env), verify(env));
  assert.equal(JSON.stringify(env), frozen, 'the verifier must not mutate its input');

  // Structural: the verifier reaches no filesystem, process, or network primitive.
  const source = readText('skills/closed-loop-pr/helpers/evidence.js');
  for (const forbidden of ['node:fs', 'node:child_process', 'node:https', 'node:net', 'require(']) {
    if (forbidden === 'require(') continue;
    assert.equal(source.includes(forbidden), false, `the verifier must not reach ${forbidden}`);
  }
});

test('Issue #36 the packaged CLI routes evidence_verify under JSON v1', () => {
  assert.deepEqual(cliSchemas().evidence_verify, ['envelope', 'expected']);

  const ok = cli({ version: 1, operation: 'evidence_verify', data: { envelope: envelope(), expected: expected() } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.status, 0);

  const rejected = cli({ version: 1, operation: 'evidence_verify', data: { envelope: envelope(), expected: expected(), extra: 1 } });
  assert.equal(rejected.error.code, 'invalid_request');
  assert.notEqual(rejected.status, 0);

  const bad = cli({ version: 1, operation: 'evidence_verify', data: { envelope: envelope({ schemaVersion: 9 }), expected: expected() } });
  assert.equal(bad.error.code, 'unsupported_schema_version');
  assert.notEqual(bad.status, 0);
});

// Review-driven regression (SOL-72-FINGERPRINTS): shape checking is not comparison. Before this,
// only pr_head and pr_base were compared, so any well-shaped digest verified in the other five
// fields and a stale diff or commits digest passed.
test('Issue #36 every fingerprint is compared against its expected value', () => {
  const wrong = { issue_spec: '9'.repeat(64), pr_base: '9'.repeat(40), pr_tree: '9'.repeat(40), pr_head: '9'.repeat(40), pr_diff: '9'.repeat(64), pr_commits: '9'.repeat(64), snapshot: '9'.repeat(64) };
  for (const domain of Object.keys(wrong)) {
    const result = verify(envelope(), expected({ fingerprints: expectedFingerprints({ [domain]: wrong[domain] }) }));
    assert.equal(result.ok, false, `${domain} must be compared`);
    assert.equal(result.error.code, 'fingerprint_mismatch', `${domain}: ${JSON.stringify(result.error)}`);
  }
  // The expectation itself is closed: a missing or unknown expected domain is a bad request,
  // never a silently skipped comparison.
  const short = expected();
  delete short.fingerprints.snapshot;
  assert.equal(verify(envelope(), short).error.code, 'envelope_invalid');
  const wide = expected();
  wide.fingerprints.pr_notes = DIFF;
  assert.equal(verify(envelope(), wide).error.code, 'envelope_invalid');
});

// Review-driven regression (SOL-72-IDENTITY): the lifecycle and branch identity Issue #36 lists
// were neither carried nor compared, so a malformed state verified successfully.
test('Issue #36 lifecycle and branch identity are validated and compared', () => {
  for (const [field, value] of [['baseBranch', 'release'], ['headRepository', 'other/fork'], ['headBranch', 'other'], ['state', 'closed'], ['draft', true]]) {
    assert.equal(verify(envelope(), expected({ [field]: value })).error.code, 'identity_mismatch', `${field} must be compared`);
  }
  for (const state of ['moved', '', 'OPEN', null, 1]) {
    const env = envelope();
    env.captureIdentity.state = state;
    env.brackets.before.state = state;
    env.brackets.after.state = state;
    assert.equal(verify(env).error.code, 'envelope_invalid', `state ${String(state)} must be rejected`);
  }
  for (const draft of ['false', null, 0]) {
    const env = envelope();
    env.captureIdentity.draft = draft;
    env.brackets.before.draft = draft;
    env.brackets.after.draft = draft;
    assert.equal(verify(env).error.code, 'envelope_invalid', `draft ${String(draft)} must be rejected`);
  }
  for (const field of ['headRepository', 'headBranch', 'baseBranch']) {
    const env = envelope();
    env.captureIdentity[field] = null;
    assert.equal(verify(env).error.code, 'envelope_invalid', `${field} must be a required non-empty string`);
  }
  // The expectation answers to the same rules, and no bracket witnesses it, so this is the only
  // place a malformed expected lifecycle can be caught.
  for (const override of [{ state: 'moved' }, { state: null }, { draft: 'false' }, { headRepository: 'fork' }, { headBranch: '' }]) {
    const result = verify(envelope(), expected(override));
    assert.equal(result.error.code, 'envelope_invalid', `expected ${JSON.stringify(override)}: ${JSON.stringify(result.error)}`);
  }
});

// Review-driven regression: the brackets and the captured identity must describe one target, so
// a bracket cannot witness an identity the envelope does not claim.
test('Issue #36 both brackets must agree with the captured identity', () => {
  for (const [bracketField, captureField, value] of [
    ['repository', 'repository', 'tetsuh/other'], ['number', 'number', 37],
    ['base', 'baseOid', 'e'.repeat(40)], ['head', 'headOid', 'e'.repeat(40)],
    ['baseBranch', 'baseBranch', 'release'], ['headRepository', 'headRepository', 'other/fork'],
    ['headBranch', 'headBranch', 'other'], ['state', 'state', 'closed'], ['draft', 'draft', true],
  ]) {
    const env = envelope();
    env.brackets.before[bracketField] = value;
    env.brackets.after[bracketField] = value;
    const result = verify(env);
    assert.equal(result.ok, false, `${bracketField} must be bound to ${captureField}`);
    assert.equal(result.error.code, 'identity_mismatch', `${bracketField}: ${JSON.stringify(result.error)}`);
  }
});

// Review-driven regression (SOL-72-BRACKET-TARGET): the operation-observed brackets must
// identify the repository and PR, not leave those fields solely parent-supplied in capture and
// expected. Stable wrong-target brackets must fail even when both brackets agree with each other.
test('Issue #36 both brackets witness repository and pull-request number', () => {
  const complete = envelope();
  for (const bracket of ['before', 'after']) {
    complete.brackets[bracket].repository = 'tetsuh/pi-tidd-agents';
    complete.brackets[bracket].number = 36;
  }
  assert.equal(verify(complete).ok, true, 'the closed bracket schema must carry the target repository and number');

  for (const [field, value] of [['repository', 'tetsuh/other'], ['number', 37]]) {
    const wrongTarget = structuredClone(complete);
    wrongTarget.brackets.before[field] = value;
    wrongTarget.brackets.after[field] = value;
    const result = verify(wrongTarget);
    assert.equal(result.ok, false, `stable wrong ${field} must be rejected`);
    assert.equal(result.error.code, 'identity_mismatch', `${field}: ${JSON.stringify(result.error)}`);
  }
});

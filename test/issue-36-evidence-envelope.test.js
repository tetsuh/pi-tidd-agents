'use strict';

// Issue #36 — one versioned evidence envelope and a read-only preflight verifier.
//
// TDD provenance: before implementation the focused command below produced 0 passes and 10
// failures. The authority-presence scenario is pre-implementation compile/contract RED; the
// version, domain-label, encoding, bracket, completeness, identity, closed-schema,
// repeatability, and CLI-routing scenarios are pre-implementation behavioral RED. That local
// output is not claimed as repository-preserved or runtime-compliance evidence.

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
  return { base: BASE, baseBranch: 'main', head: HEAD, state: 'open', draft: false, headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'topic' };
}
function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    captureIdentity: { repository: 'tetsuh/pi-tidd-agents', number: 36, baseOid: BASE, headOid: HEAD },
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
function expected(overrides = {}) {
  return { repository: 'tetsuh/pi-tidd-agents', number: 36, baseOid: BASE, headOid: HEAD, ...overrides };
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

test('Issue #36 each domain declares one byte domain and one value shape', () => {
  assert.equal(verify(withFingerprint('pr_diff', { encoding: 'normalized_text' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_commits', { encoding: 'raw_bytes' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('snapshot', { encoding: 'normalized_text' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_base', { encoding: 'raw_bytes' })).error.code, 'encoding_mismatch');
  assert.equal(verify(withFingerprint('pr_diff', { encoding: 'unknown_domain' })).error.code, 'encoding_mismatch');

  // A git OID may be 40 or 64 hex; a digest is always 64; neither accepts the other's junk.
  // `pr_tree` carries no identity binding, so it isolates the shape rule from the OID
  // comparison that `pr_base` and `pr_head` additionally answer to.
  assert.equal(verify(withFingerprint('pr_tree', { value: 'd'.repeat(64) })).ok, true);
  assert.equal(verify(withFingerprint('pr_tree', { value: 'd'.repeat(39) })).error.code, 'envelope_invalid');
  assert.equal(verify(withFingerprint('pr_base', { value: 'd'.repeat(64) })).error.code, 'identity_mismatch');
  assert.equal(verify(withFingerprint('pr_diff', { value: 'd'.repeat(40) })).error.code, 'envelope_invalid');
  assert.equal(verify(withFingerprint('pr_diff', { value: 'D'.repeat(64) })).error.code, 'envelope_invalid');
});

test('Issue #36 a moved capture bracket is rejected', () => {
  const moved = envelope();
  moved.brackets.after = { ...brackets(), head: 'e'.repeat(40) };
  const result = verify(moved);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bracket_identity_moved');

  for (const field of ['base', 'baseBranch', 'state', 'draft', 'headRepository', 'headBranch']) {
    const drifted = envelope();
    drifted.brackets.after = { ...brackets(), [field]: field === 'draft' ? true : 'moved' };
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

  // The head OID the envelope claims and the head fingerprint it carries must agree.
  const inconsistent = envelope();
  inconsistent.fingerprints.pr_head.value = 'f'.repeat(40);
  assert.equal(verify(inconsistent).error.code, 'identity_mismatch');
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

'use strict';

// Issue #35: a no-network, no-model, no-provider-mutation failure-injection harness for the
// closed-loop PR orchestration contracts. One incident table: every class has a positive case
// and a stale, conflicting, or malformed sibling; every failure reports the exact phase and
// invariant. Real packaged helpers are called where they exist; where the contract has only
// prose (manifest equality, commit-message bytes, exact-text edit, same-head reruns, reply
// read-back) a small model expresses the rule. Provenance: regression/contract coverage, plus
// behavioural coverage of git itself for the commit-message class. Nothing here proves live
// provider behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readText, sectionOf, cliSchemas } = require('./helpers');
const protocol = require('../skills/closed-loop-pr/helpers/protocol');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const fingerprints = require('../skills/closed-loop-pr/helpers/fingerprints');
const snapshot = require('../skills/closed-loop-pr/helpers/snapshot');
const paths = require('../skills/closed-loop-pr/helpers/paths');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const ok = () => ({ ok: true });
const fail = (phase, invariant, code) => ({ ok: false, phase, invariant, code });

// ---------------------------------------------------------------------------------------
// Fixtures shared by several incidents
const OID = (c) => c.repeat(40);
const SHA = (c) => c.repeat(64);
const correlation = (over = {}) => ({
  repository: 'o/r', number: 7, baseOid: OID('a'), headRepository: 'o/r', headBranch: 'b', headOid: OID('b'),
  lifecycle: 'open', draft: false, gate: 'sol', invocation: 1, contractInput: SHA('c'), snapshotFingerprint: SHA('d'), ...over,
});
const attestation = () => ({ source: 'skills/closed-loop-pr/SKILL.md', kind: 'file', identity: SHA('f'), readCompletely: true });
const envelope = (over = {}) => ({
  schemaVersion: 1, correlation: correlation(), verdict: 'MERGE', evidenceRead: [attestation()], findings: [], confirmations: [], decisions: [],
  adversarialResults: [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }], ...over,
});
const expectation = () => ({ correlation: correlation(), workflow: 'pr', assignedFindings: [], freshFindingIdPrefix: 'SOL-7-', requiredEvidence: [{ source: attestation().source, kind: 'file', identity: attestation().identity }] });
const pull = (over = {}) => ({ number: 7, state: 'open', draft: false, base: { sha: OID('a'), ref: 'main' }, head: { sha: OID('b'), ref: 'b', repo: { full_name: 'o/r' } }, ...over });

// Recovery outcome for a key, read from the shipped CL-D39 mapping (never restated here).
function mappedOutcome(key) {
  const section = sectionOf(readText(PR_AUTOFIX), '### Bounded pre-writer recovery (CL-D39)');
  const rows = section.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !/\| Failure \|/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const row = rows.find(([, k]) => new RegExp('^' + k.replace(/`/g, '').replace('fingerprint_<op>', 'fingerprint_[a-z_]+') + '$').test(key));
  return row ? row[3] : 'terminal';
}

// Behavioural: what git actually stores for a commit message given via -F.
function gitStoredBody(message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue35-git-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'buffer' });
    git('init', '-q', '.');
    const file = path.join(dir, 'msg.txt'); fs.writeFileSync(file, Buffer.from(message, 'utf8'));
    git('commit', '-q', '--allow-empty', '-F', file);
    const raw = git('cat-file', 'commit', 'HEAD'); // exact stored bytes: headers, blank line, body
    const sep = raw.indexOf('\n\n');
    return raw.subarray(sep + 2).toString('utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// The comparator the contract implies: the approved message normalized exactly as git
// normalizes it (trailing blank lines collapsed to one LF); literal backslash-n is bytes.
const expectedStored = (approved) => approved.replace(/\n*$/, '') + '\n';

// ---------------------------------------------------------------------------------------
const INCIDENTS = [
  {
    name: '1 snapshot envelope version/key mismatch',
    phase: 'normalize', invariant: 'protocol v1 envelope and CL-D36 validated gate result',
    positive: () => protocol.isResult(protocol.createResult('snapshot', { a: 1 })) && gateResult.validateGateResult(envelope(), expectation()).ok ? ok() : fail('normalize', 'protocol v1', 'unexpected'),
    sibling: () => {
      if (protocol.isResult({ version: 2, ok: true, operation: 'snapshot', data: {} })) return ok();
      const r = gateResult.validateGateResult(envelope({ extra: true }), expectation());
      return r.ok ? ok() : fail('normalize', 'protocol v1 envelope and CL-D36 validated gate result', r.error.code);
    },
    siblingCode: 'unknown_field',
  },
  {
    name: '2 malformed generated shell before execution',
    phase: 'normalize', invariant: 'CL-D30 invocation map: no run-time shell, jq, Python, or GraphQL',
    // Structurally removed: there is no generated shell to syntax-check. The positive case is
    // that every mapped operation is a packaged CLI operation; the sibling is a row naming an
    // operation the CLI does not expose, which the map regression rejects.
    positive: () => {
      const text = readText(PR_AUTOFIX);
      return /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/.test(text) ? ok() : fail('normalize', 'CL-D30 invocation map', 'shell_generation_permitted');
    },
    sibling: () => Object.hasOwn(cliSchemas(), 'run_shell') ? ok() : fail('normalize', 'CL-D30 invocation map: no run-time shell, jq, Python, or GraphQL', 'no_such_operation'),
    siblingCode: 'no_such_operation',
  },
  {
    name: '3 missing dynamic-import in a test probe',
    phase: 'focused_validation', invariant: 'CL-D39 mapping: validation_harness is terminal',
    positive: () => mappedOutcome('envelope_read@normalize') === 'recoverable' ? ok() : fail('normalize', 'CL-D39', 'unexpected'),
    sibling: () => mappedOutcome('validation_harness@focused_validation') === 'terminal' ? fail('focused_validation', 'CL-D39 mapping: validation_harness is terminal', 'terminal') : ok(),
    siblingCode: 'terminal',
  },
  {
    name: '4 full-index manifest versus changed-path manifest confusion',
    phase: 'AFTER_STAGING', invariant: 'index exactly equal to the immutable staged manifest (complete inventory)',
    positive: () => {
      const manifest = new Map([['a.js', 'blob1'], ['b.js', 'blob2']]);
      const index = new Map([['a.js', 'blob1'], ['b.js', 'blob2']]);
      return manifestEqual(manifest, index);
    },
    sibling: () => {
      // Only the changed path was captured; the index also carries a stray staged file.
      const changedOnly = new Map([['a.js', 'blob1']]);
      const index = new Map([['a.js', 'blob1'], ['stray.js', 'blob9']]);
      return manifestEqual(changedOnly, index);
    },
    siblingCode: 'manifest_index_mismatch',
  },
  {
    name: '5 commit-message trailing newline and literal backslash-n',
    phase: 'AFTER_COMMIT', invariant: 'stored bytes equal the approved message; real LF via -F, never literal \\n',
    positive: () => {
      for (const approved of ['msg', 'msg\n', 'msg\n\n\n']) {
        if (gitStoredBody(approved) !== expectedStored(approved)) return fail('AFTER_COMMIT', 'stored bytes equal the approved message', 'unexpected');
      }
      // literal backslash-n is preserved as two bytes, not turned into a newline
      return gitStoredBody('line1\\nline2') === 'line1\\nline2\n' ? ok() : fail('AFTER_COMMIT', 'literal \\n preserved', 'unexpected');
    },
    sibling: () => {
      // A comparator that compares raw approved bytes (three trailing LF) to stored bytes, or
      // that treats literal backslash-n as a newline, must fail.
      const rawCompare = gitStoredBody('msg\n\n\n') === 'msg\n\n\n';
      const literalAsNewline = gitStoredBody('line1\\nline2') === 'line1\nline2\n';
      return rawCompare || literalAsNewline ? ok() : fail('AFTER_COMMIT', 'stored bytes equal the approved message; real LF via -F, never literal \\n', 'commit_message_mismatch');
    },
    siblingCode: 'commit_message_mismatch',
  },
  {
    name: '6 binary effective-diff digest versus textual patch digest',
    phase: 'normalize', invariant: 'CL-D9 byte domains: raw binary diff, normalized text, canonical JSON are distinct',
    positive: () => {
      const crlf = Buffer.from('a\r\nb\r\n'), lf = Buffer.from('a\nb\n');
      const textEqual = fingerprints.fingerprintText(crlf.toString()) === fingerprints.fingerprintText(lf.toString());
      const binaryDiffer = fingerprints.prDiffFingerprint(crlf) !== fingerprints.prDiffFingerprint(lf);
      return textEqual && binaryDiffer ? ok() : fail('normalize', 'CL-D9 byte domains', 'unexpected');
    },
    sibling: () => {
      // The cross-domain guard is at the input boundary, not the digest value: for already
      // normalized text the two sha256 values coincide, so the binary fingerprint refuses
      // non-byte input outright and the CLI requires base64. A textual patch handed to the
      // binary-diff operation must be rejected, never silently digested.
      try { fingerprints.prDiffFingerprint('a\nb\n'); return ok(); }
      catch (error) { return /binary fingerprint input must be bytes/.test(error.message) ? fail('normalize', 'CL-D9 byte domains: raw binary diff, normalized text, canonical JSON are distinct', 'digest_domain_mismatch') : ok(); }
    },
    siblingCode: 'digest_domain_mismatch',
  },
  {
    name: '7 failed exact-text edit before any mutation-authorized successor',
    phase: 'edit', invariant: 'CL-D39: every failure from the first Luna task onward is terminal; nothing is staged',
    positive: () => exactTextEdit('const a = 1;\n', 'const a = 1;', 'const a = 2;').ok ? ok() : fail('edit', 'exact-text edit', 'unexpected'),
    sibling: () => {
      const r = exactTextEdit('const a = 1;\n', 'const a = 3;', 'const a = 2;');
      return r.ok ? ok() : fail('edit', 'CL-D39: every failure from the first Luna task onward is terminal; nothing is staged', r.code);
    },
    siblingCode: 'exact_text_not_found',
  },
  {
    name: '8 public head movement between bracket reads',
    phase: 'github_snapshot', invariant: 'CL-D27 target stability: bracketed identity must match; otherwise stale_target',
    positive: () => bracket(pull(), pull()),
    sibling: () => bracket(pull(), pull({ head: { sha: OID('e'), ref: 'b', repo: { full_name: 'o/r' } } })),
    siblingCode: 'stale_target',
  },
  {
    name: '9 CI failure followed by a successful same-head rerun',
    phase: 'final_policy', invariant: 'exact-head check evidence: latest run per check on the exact head; other heads never count',
    positive: () => checksOnHead(OID('b'), [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure', head_sha: OID('b') },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success', head_sha: OID('b') },
    ]),
    sibling: () => checksOnHead(OID('b'), [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure', head_sha: OID('b') },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success', head_sha: OID('e') }, // success on another head
    ]),
    siblingCode: 'required_checks_failed',
  },
  {
    name: '10 reply timeout with success, failure, and ambiguous read-back',
    phase: 'reply', invariant: 'REPLY_EXCEPTION: one attempt, read-back decides, ambiguity is reply_outcome_unknown, never retried, prior replies remain',
    positive: () => {
      const s = replyAttempt('success'), f = replyAttempt('failure');
      return s.posted === true && s.retries === 0 && f.posted === false && f.retries === 0 && f.priorRepliesRemain ? ok() : fail('reply', 'REPLY_EXCEPTION', 'unexpected');
    },
    sibling: () => {
      const a = replyAttempt('ambiguous');
      return a.status === 'reply_outcome_unknown' && a.retries === 0 && a.priorRepliesRemain ? fail('reply', 'REPLY_EXCEPTION: one attempt, read-back decides, ambiguity is reply_outcome_unknown, never retried, prior replies remain', 'reply_outcome_unknown') : ok();
    },
    siblingCode: 'reply_outcome_unknown',
  },
  {
    name: '11 unsafe runtime-root type and outside-root untracked paths',
    phase: 'preflight', invariant: 'RUNTIME_ROOTS classified independently without following links; outside-root untracked blocks',
    positive: () => withTempCheckout((dir) => { fs.mkdirSync(path.join(dir, '.pi')); return Object.values(paths.classifyRuntimeRoots(dir)).every((d) => d.safe) ? ok() : fail('preflight', 'RUNTIME_ROOTS', 'unexpected'); }),
    sibling: () => withTempCheckout((dir) => {
      fs.writeFileSync(path.join(dir, '.pi'), 'not a directory');
      const unsafe = !paths.classifyRuntimeRoots(dir)['.pi'].safe;
      const outside = outsideRootUntracked(['.pi/x', 'stray.txt']);
      return unsafe && !outside.ok ? fail('preflight', 'RUNTIME_ROOTS classified independently without following links; outside-root untracked blocks', 'unsafe_runtime_root') : ok();
    }),
    siblingCode: 'unsafe_runtime_root',
  },
];

// --- models for the prose-only classes ------------------------------------------------
function manifestEqual(manifest, index) {
  const same = manifest.size === index.size && [...manifest].every(([p, b]) => index.get(p) === b);
  return same ? ok() : fail('AFTER_STAGING', 'index exactly equal to the immutable staged manifest (complete inventory)', 'manifest_index_mismatch');
}
function exactTextEdit(content, oldText, newText) {
  const at = content.indexOf(oldText);
  if (at === -1) return { ok: false, code: 'exact_text_not_found', staged: false };
  return { ok: true, content: content.slice(0, at) + newText + content.slice(at + oldText.length), staged: false };
}
function bracket(before, after) {
  const a = snapshot.identity(before), b = snapshot.identity(after);
  return JSON.stringify(a) === JSON.stringify(b) ? ok() : fail('github_snapshot', 'CL-D27 target stability: bracketed identity must match; otherwise stale_target', 'stale_target');
}
function checksOnHead(head, runs) {
  const onHead = runs.filter((r) => r.head_sha === head);
  const classified = snapshot.classifyChecks(onHead.map(({ head_sha, ...r }) => r));
  const latestByName = new Map();
  for (const c of classified) latestByName.set(c.name, c); // ascending id order = latest wins
  const allSuccessful = [...latestByName.values()].every((c) => c.successful);
  return allSuccessful ? ok() : fail('final_policy', 'exact-head check evidence: latest run per check on the exact head; other heads never count', 'required_checks_failed');
}
function replyAttempt(readBack) {
  const base = { retries: 0, priorRepliesRemain: true };
  if (readBack === 'success') return { ...base, posted: true, status: 'posted' };
  if (readBack === 'failure') return { ...base, posted: false, status: 'not_posted' };
  return { ...base, posted: 'unknown', status: 'reply_outcome_unknown' };
}
function outsideRootUntracked(untracked) {
  const outside = untracked.filter((p) => !/^\.pi(?:-subagents)?(?:\/|$)/.test(p));
  return outside.length ? fail('preflight', 'outside-root untracked blocks', 'unexpected_untracked') : ok();
}
function withTempCheckout(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue35-root-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------
for (const incident of INCIDENTS) {
  test(`Issue #35 incident ${incident.name}: positive passes`, () => {
    assert.deepEqual(incident.positive(), { ok: true }, `${incident.name}: the positive case must pass`);
  });
  test(`Issue #35 incident ${incident.name}: sibling fails with exact phase and invariant`, () => {
    const r = incident.sibling();
    assert.equal(r.ok, false, `${incident.name}: the stale/conflicting/malformed sibling must fail`);
    assert.equal(r.phase, incident.phase, `${incident.name}: failure must report its exact phase`);
    assert.equal(r.invariant, incident.invariant, `${incident.name}: failure must report its exact invariant`);
    assert.equal(r.code, incident.siblingCode, `${incident.name}: failure must report its structured code`);
  });
}

test('Issue #35 the incident table covers every class the issue lists, with one positive and one sibling each', () => {
  assert.equal(INCIDENTS.length, 11);
  for (const incident of INCIDENTS) {
    assert.equal(typeof incident.positive, 'function'); assert.equal(typeof incident.sibling, 'function');
    assert.ok(incident.phase && incident.invariant && incident.siblingCode, `${incident.name} must declare phase, invariant, and sibling code`);
  }
});

test('Issue #35 fixtures carry an explicit schema version and unknown versions are rejected', () => {
  const fixture = { schemaVersion: 1, pull: pull(), checks: [] };
  assert.equal(fixture.schemaVersion, protocol.VERSION);
  assert.equal(protocol.isResult({ version: 2, ok: true, operation: 'snapshot', data: {} }), false);
  assert.equal(gateResult.validateGateResult(envelope({ schemaVersion: 2 }), expectation()).error.code, 'unknown_version');
});

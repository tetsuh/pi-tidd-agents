'use strict';

// Issue #64 item 1 (CL-D72) — the packaged validation run separates "the command could not run" from
// "the command ran and reported failure", both terminal, with distinct codes and phases.
//
// TDD provenance: behavioral RED against a helper surface with no `validation_run` — the fixture repository
// and the child commands below ran before validation.js existed. The map, README, record, and manifest
// scenarios are compile/contract RED against absent prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf, cliSchemas } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const NODE = process.execPath;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function cli(operation, data) {
  const run = spawnSync(NODE, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-repo-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 64 Test']);
  git(root, ['config', 'user.email', 'issue64@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'test: base']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}
const script = (code) => [NODE, '-e', code || '0'];

test('Issue #64 validation_run reports passed, validation_failed, and harness_failed as distinct outcomes', async () => {
  const repo = repository();
  try {
    const passed = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write("ok\\n"); process.stderr.write("note\\n")') });
    assert.equal(passed.ok, true, JSON.stringify(passed.error));
    assert.equal(passed.data.outcome, 'passed');
    assert.equal(passed.data.exitCode, 0);
    assert.deepEqual(passed.data.stdout, { bytes: 3, sha256: sha256('ok\n'), tail: 'ok\n' }, 'stdout is reported by bytes, digest, and tail');
    assert.deepEqual(passed.data.stderr, { bytes: 5, sha256: sha256('note\n'), tail: 'note\n' });
    assert.equal(typeof passed.data.durationMs, 'number');
    assert.deepEqual(passed.data.command, script('process.stdout.write("ok\\n"); process.stderr.write("note\\n")'), 'the argv is echoed as run');

    const failed = await helpers.validationRun({ cwd: repo.root, command: script('process.stderr.write("bad\\n"); process.exit(3)') });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'validation_failed', JSON.stringify(failed.error));
    assert.equal(failed.error.phase, 'validation');
    assert.equal(failed.error.details.exitCode, 3);
    assert.equal(failed.error.details.stderr.tail, 'bad\n');
    assert.equal(failed.error.details.stderr.sha256, sha256('bad\n'), 'the failure carries the same evidence as a pass');

    const missing = await helpers.validationRun({ cwd: repo.root, command: [path.join(repo.root, 'no-such-validator')] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'harness_failed', JSON.stringify(missing.error));
    assert.equal(missing.error.phase, 'spawn');
    assert.equal(missing.error.details.reason, 'ENOENT');
    assert.equal(missing.error.details.exitCode, null);

    const slow = await helpers.validationRun({ cwd: repo.root, command: script('setTimeout(() => {}, 5000)'), timeoutMs: 200 });
    assert.equal(slow.error.code, 'harness_failed', JSON.stringify(slow.error));
    assert.equal(slow.error.phase, 'spawn');
    assert.equal(slow.error.details.reason, 'timeout');

    if (process.platform !== 'win32') {
      const killed = await helpers.validationRun({ cwd: repo.root, command: script('process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 2000)') });
      assert.equal(killed.error.code, 'harness_failed', JSON.stringify(killed.error));
      assert.equal(killed.error.details.reason, 'signal:SIGTERM');
    }
    // The two failure classes differ in code and in phase, as the acceptance criterion requires.
    assert.notEqual(failed.error.code, missing.error.code);
    assert.notEqual(failed.error.phase, missing.error.phase);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Issue #64 validation_run takes an argv, never a shell, and runs only at a Git toplevel', async () => {
  const repo = repository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-outside-'));
  try {
    // No shell: a metacharacter argument reaches the program as text.
    const literal = await helpers.validationRun({ cwd: repo.root, command: [...script('process.stdout.write(process.argv[1])'), '$(echo expanded); `echo expanded`'] });
    assert.equal(literal.ok, true, JSON.stringify(literal.error));
    assert.equal(literal.data.stdout.tail, '$(echo expanded); `echo expanded`');
    // The environment is the package's sanitized one: no terminal prompts from Git, and a real HOME for toolchains.
    const env = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}|${typeof process.env.HOME}|${process.env.LC_ALL}`)') });
    assert.equal(env.data.stdout.tail, '0|string|C');
    for (const [label, data] of [
      ['a shell string', { cwd: repo.root, command: 'npm test' }],
      ['an empty argv', { cwd: repo.root, command: [] }],
      ['an empty argument', { cwd: repo.root, command: [NODE, ''] }],
      ['a non-string argument', { cwd: repo.root, command: [NODE, 7] }],
      ['a relative cwd', { cwd: 'sub', command: script('') }],
      ['a zero timeout', { cwd: repo.root, command: script(''), timeoutMs: 0 }],
      ['a timeout above the cap', { cwd: repo.root, command: script(''), timeoutMs: 3600001 }],
    ]) {
      const refused = await helpers.validationRun(data);
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.phase, 'request', label);
    }
    for (const [label, cwd] of [['a subdirectory of the checkout', path.join(repo.root, 'sub')], ['a directory outside any checkout', outside], ['a missing directory', path.join(repo.root, 'absent')]]) {
      const refused = await helpers.validationRun({ cwd, command: script('') });
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.phase, 'cwd', label);
    }
    // Through the CLI, with exactly the declared request fields.
    assert.deepEqual(cliSchemas().validation_run, ['cwd', 'command'], 'the required request fields');
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /validation_run: \{ required: \['cwd', 'command'\], optional: \['timeoutMs'\] \}/, 'the timeout is the only optional field');
    const viaCli = cli('validation_run', { cwd: repo.root, command: script('process.exit(2)') });
    assert.equal(viaCli.ok, false); assert.equal(viaCli.error.code, 'validation_failed'); assert.equal(viaCli.status, 1);
    const viaCliPassed = cli('validation_run', { cwd: repo.root, command: script('') });
    assert.equal(viaCliPassed.ok, true, JSON.stringify(viaCliPassed.error)); assert.equal(viaCliPassed.status, 0);
    assert.equal(cli('validation_run', { cwd: repo.root, command: script(''), shell: true }).error.message, 'unknown request field: shell');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('Issue #64 the map, the README, the recovery key, and the record name the packaged validation run', () => {
  const autofix = readText('skills/closed-loop-pr/references/autofix.md');
  const map = sectionOf(autofix, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map.includes("| The focused validation, in review-only's validation step and after the writer's edit (CL-D39, CL-D72) | `validation_run` | `cwd` (a Git toplevel), `command` (an argv, never a shell string), `timeoutMs` (optional) |"), 'the map offers validation_run with its fields');
  assert.ok(autofix.includes('| validation harness could not run (`validation_run` reports `harness_failed`) | `validation_run@focused_validation` | none | terminal | post-writer; all evidence stands |'), 'the recovery row names the packaged operation');
  assert.equal(autofix.includes('validation_harness@focused_validation'), false, 'the old key is gone');
  assert.match(readText('README.md'), /`validation_run` spawns the target's validation command as an argv at a Git toplevel/);
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D72 — The focused validation is packaged and the alarm is reset for it');
  for (const phrase of ['https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5654184082', 'https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5654208805', 'Option A on all three', 'exactly one non-git spawn site, in `validation.js`', 'resets from 220,000 to 240,000 bytes']) assert.ok(record.includes(phrase), `CL-D72 record: ${phrase}`);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D72').map((clause) => clause.id), ['CL-D72-map', 'CL-D72-record', 'CL-D72-tests']);
  // The structural rule the record states: one non-git spawn site, in validation.js, and no shell anywhere.
  const helpersDir = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers');
  const sites = [];
  for (const file of fs.readdirSync(helpersDir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(helpersDir, file), 'utf8');
    for (const match of source.matchAll(/kind: 'validation'/g)) sites.push(`${file}:${match.index}`);
    assert.equal(/shell:\s*true/.test(source), false, `${file} never spawns through a shell`);
  }
  assert.equal(sites.length, 1, `exactly one validation spawn site: ${sites.join(', ')}`);
  assert.match(sites[0], /^validation\.js:/);
});

// CL-D72, third choice: the gate's required-evidence set is derived, not assembled by hand — the paths the change
// touches that exist at the head, the two authority files, each identified by the SHA-256 of its blob at the head,
// plus the identity records the parent holds, unchanged.
function evidenceRepository({ authority = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-evidence-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 64 Test']);
  git(root, ['config', 'user.email', 'issue64@example.invalid']);
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  if (authority) { write('CONTRACT.md', 'contract one\n'); write('README.md', 'readme\n'); }
  write('a.txt', 'a one\n'); write('deleted.txt', 'gone\n'); write('dir/b.txt', 'b\n');
  git(root, ['add', '.']); git(root, ['commit', '-q', '-m', 'test: base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write('a.txt', 'a two\n'); if (authority) write('CONTRACT.md', 'contract two\n');
  write('new file.txt', 'new\n'); write('bin.dat', Buffer.from([0, 255, 1, 2, 10, 13]));
  fs.rmSync(path.join(root, 'deleted.txt'));
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'test: head']);
  return { root, base, head: git(root, ['rev-parse', 'HEAD']) };
}
const blobSha = (root, file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('Issue #64 required_evidence_set derives the set from the change and the authority files', () => {
  const repo = evidenceRepository();
  const bare = evidenceRepository({ authority: false });
  try {
    const identities = [
      { source: 'git:pr_base', kind: 'git', identity: repo.base }, { source: 'git:pr_head', kind: 'git', identity: repo.head },
      { source: 'github:pr:64:body', kind: 'github', identity: 'f'.repeat(64) }, { source: 'git:snapshot', kind: 'snapshot', identity: 'e'.repeat(64) },
    ];
    const derived = helpers.requiredEvidenceSet({ cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities });
    assert.equal(derived.ok, true, JSON.stringify(derived.error));
    const file = (source) => ({ source, kind: 'file', identity: blobSha(repo.root, source) });
    assert.deepEqual(derived.data.requiredEvidence, [file('CONTRACT.md'), file('README.md'), file('a.txt'), file('bin.dat'), file('new file.txt'), ...identities],
      'changed paths existing at the head, in byte order, then the authority files that did not change, then the identities as given; the deleted path and the untouched path are absent');
    assert.deepEqual(derived.data.authority, { included: ['CONTRACT.md', 'README.md'], absent: [] });
    assert.deepEqual([derived.data.changed, derived.data.files], [5, 5], 'five paths changed, one of them deleted; README is the fifth file');
    assert.deepEqual(helpers.requiredEvidenceSet({ cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities }), derived, 'the derivation is deterministic');
    // The derived set passes the packaged checks downstream exactly as a hand-assembled one would.
    assert.equal(helpers.requiredEvidenceCheck({ cwd: repo.root, requiredEvidence: derived.data.requiredEvidence }).ok, true);
    const expectation = helpers.buildGateExpectation({ workflow: 'pr', correlation: { repository: 'o/r', number: 64, baseOid: repo.base, headRepository: 'o/r', headBranch: 'b', headOid: repo.head, lifecycle: 'open', draft: false, gate: 'adversarial', invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'e'.repeat(64) }, assignedFindings: [], requiredEvidence: derived.data.requiredEvidence });
    assert.equal(expectation.ok, true, JSON.stringify(expectation.error));
    // A target without the authority files: reported as absent, not refused.
    const bareSet = helpers.requiredEvidenceSet({ cwd: bare.root, baseOid: bare.base, headOid: bare.head, identities: [] });
    assert.equal(bareSet.ok, true, JSON.stringify(bareSet.error));
    assert.deepEqual(bareSet.data.authority, { included: [], absent: ['CONTRACT.md', 'README.md'] });
    assert.deepEqual(bareSet.data.requiredEvidence.map((entry) => entry.source), ['a.txt', 'bin.dat', 'new file.txt']);
    for (const [label, data, subcheck] of [
      ['a file-kind identity', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'a.txt', kind: 'file', identity: 'f'.repeat(64) }] }, 'identities_shape'],
      ['an unknown kind', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'x', kind: 'web', identity: 'f'.repeat(64) }] }, 'identities_shape'],
      ['an identity record with an extra key', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'x', kind: 'git', identity: repo.head, note: 'n' }] }, 'identities_shape'],
      ['a base that is not a commit here', { cwd: repo.root, baseOid: 'f'.repeat(40), headOid: repo.head, identities: [] }, 'commit_presence'],
      ['a head that is not an OID', { cwd: repo.root, baseOid: repo.base, headOid: 'main', identities: [] }, 'request_shape'],
      ['a cwd below the toplevel', { cwd: path.join(repo.root, 'dir'), baseOid: repo.base, headOid: repo.head, identities: [] }, 'cwd_toplevel'],
      ['two identities of one source', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_head', kind: 'git', identity: repo.head }, { source: 'git:pr_head', kind: 'git', identity: repo.head + '' }] }, 'required_evidence_shape'],
      // An identity the request repeats agrees with the argument it repeats, or the request is refused.
      ['a head identity disagreeing with headOid', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_head', kind: 'git', identity: repo.base }] }, 'identity_correlation'],
      ['a base identity disagreeing with baseOid', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_base', kind: 'git', identity: repo.head }] }, 'identity_correlation'],
    ]) {
      const refused = helpers.requiredEvidenceSet(data);
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.details.subcheck, subcheck, `${label}: ${JSON.stringify(refused.error)}`);
    }
    assert.deepEqual(cliSchemas().required_evidence_set, ['cwd', 'baseOid', 'headOid', 'identities']);
    const viaCli = cli('required_evidence_set', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities });
    assert.equal(viaCli.ok, true, JSON.stringify(viaCli.error)); assert.deepEqual(viaCli.data.requiredEvidence, derived.data.requiredEvidence);
    const map = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### Packaged helper invocation map (CL-D30, Issue #47)');
    assert.ok(map.includes("| Before `required_evidence_check`, deriving the gate's required-evidence set from the change and the authority files (CL-D72) | `required_evidence_set` | `cwd` (a Git toplevel), `baseOid`, `headOid`, `identities` (the git, GitHub, and snapshot records) |"), 'the map offers required_evidence_set with its fields');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(bare.root, { recursive: true, force: true }); }
});

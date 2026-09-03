'use strict';

// Issue #105 (CL-D61) — the two manifest_compare requests and the required-evidence set were
// the last documents the parent still assembled by hand at a boundary where a shape error
// costs the whole run (PR #103: `manifest_compare` given both `authorizedPaths` and
// `manifest` at AFTER_STAGING, terminal; PR #104: a required-evidence entry naming a file the
// repository does not have, spending Terra's only retry). Two package-owned builders derive
// each request from its producing operation's data, so a request carrying both mode fields is
// unrepresentable; a read-only `required_evidence_check` makes a nonexistent required file an
// assembly error before any gate runs.
//
// TDD provenance: recorded with `node --test test/issue-105-manifest-builders.test.js` at RED
// before the builders, the check, the CLI rows, the prose, and the record existed. That local
// output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { readText, sectionOf, cliSchemas } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const SHA = '1'.repeat(64);

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-105-builders-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-105-origin-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 105 Test']);
  git(root, ['config', 'user.email', 'issue105@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: builder base']);
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}
function overlayData(parent) {
  return { parent, entries: [{ path: 'tracked.txt', status: 'M', rawDiffSha256: SHA }], authorizedPaths: ['tracked.txt'] };
}
function manifestData(parent) {
  return { parent, entries: [{ path: 'tracked.txt', status: 'M', srcMode: '100644', dstMode: '100644', srcOid: 'a'.repeat(40), dstOid: 'b'.repeat(40) }] };
}

test('Issue #105 the invocation map names the manifest builders and the evidence check', () => {
  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map, 'the invocation map must exist');
  for (const declaration of [
    '| `build_manifest_capture` | `overlay` (data of `overlay_freeze`), `cwd` |',
    '| `build_manifest_compare` | `captured` (data of `manifest_compare`), `cwd` |',
    '| `required_evidence_check` | `cwd`, `requiredEvidence` |',
  ]) assert.ok(map.includes(declaration), `map must declare ${declaration}`);
  assert.match(map, /At `AFTER_STAGING` \(capture\) and `BEFORE_COMMIT` \(compare\) \(CL-D57\), with requests built by `build_manifest_capture` and `build_manifest_compare` \(CL-D61\)/);
  assert.match(map, /a capture request derives its parent and authorized set from the frozen overlay and a compare request derives its parent from the capture it compares against, so a request carrying both mode fields is unrepresentable/);
  assert.match(map, /`required_evidence_check` is a read-only observation, not a builder: it requires every `file`-kind required-evidence entry to exist before the expectation is built/);
  const shared = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '### Structured gate result transport (CL-D36)');
  assert.match(shared, /every `file`-kind entry of that set must exist, verified through packaged `required_evidence_check` before the expectation is built, so a required file that does not exist is an assembly error and never a gate outcome \(CL-D61\)/);
});

test('Issue #105 the CLI exposes the two builders and the check with frozen inputs', () => {
  const schemas = cliSchemas();
  assert.deepEqual(schemas.build_manifest_capture, ['overlay', 'cwd']);
  assert.deepEqual(schemas.build_manifest_compare, ['captured', 'cwd']);
  assert.deepEqual(schemas.required_evidence_check, ['cwd', 'requiredEvidence']);
  assert.equal(Object.keys(schemas).filter((operation) => operation.startsWith('build_')).length, 7, 'CL-D56 five plus the CL-D61 two');
});

test('Issue #105 a request carrying both mode fields cannot be produced by a builder', () => {
  const parent = 'c'.repeat(40);
  const capture = cli('build_manifest_capture', { overlay: overlayData(parent), cwd: '/w' });
  assert.equal(capture.ok, true, JSON.stringify(capture.error));
  assert.deepEqual(capture.data.request, { version: 1, operation: 'manifest_compare', data: { cwd: '/w', parent, authorizedPaths: ['tracked.txt'] } });
  const compare = cli('build_manifest_compare', { captured: manifestData(parent), cwd: '/w' });
  assert.equal(compare.ok, true, JSON.stringify(compare.error));
  assert.deepEqual(compare.data.request, { version: 1, operation: 'manifest_compare', data: { cwd: '/w', parent, manifest: manifestData(parent) } });
  // The producing shapes are enforced by the boundary's own predicates, named by the builder's field.
  const swappedCapture = cli('build_manifest_capture', { overlay: manifestData(parent), cwd: '/w' });
  assert.equal(swappedCapture.ok, false);
  assert.equal(swappedCapture.error.code, 'input_shape_mismatch');
  assert.equal(swappedCapture.error.phase, 'build');
  assert.match(swappedCapture.error.message, /`overlay` must be data:overlay_freeze/);
  const swappedCompare = cli('build_manifest_compare', { captured: overlayData(parent), cwd: '/w' });
  assert.equal(swappedCompare.ok, false);
  assert.equal(swappedCompare.error.code, 'input_shape_mismatch');
  assert.match(swappedCompare.error.message, /`captured` must be data:manifest_compare/);
  // Extra fields (a hand-added manifest or authorizedPaths) are refused at the CLI boundary.
  const extra = cli('build_manifest_capture', { overlay: overlayData(parent), cwd: '/w', manifest: manifestData(parent) });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, 'invalid_request');
  const blank = cli('build_manifest_compare', { captured: manifestData(parent), cwd: '' });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, 'invalid_request');
  assert.match(blank.error.message, /cwd/);
});

test('Issue #105 the built requests round-trip through manifest_compare at AFTER_STAGING and BEFORE_COMMIT', () => {
  const repo = repository();
  try {
    const created = cli('workspace_create', { cwd: repo.root, head: repo.head, tree: repo.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    fs.appendFileSync(path.join(workspace, 'tracked.txt'), 'edited\n');
    const frozen = cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['tracked.txt', 'unused.md'] });
    assert.equal(frozen.ok, true, JSON.stringify(frozen.error));
    git(workspace, ['add', 'tracked.txt']);
    const captureRequest = cli('build_manifest_capture', { overlay: frozen.data, cwd: workspace });
    assert.equal(captureRequest.ok, true, JSON.stringify(captureRequest.error));
    assert.equal(captureRequest.data.request.data.parent, repo.head, 'the parent is the one the overlay froze');
    assert.deepEqual(captureRequest.data.request.data.authorizedPaths, ['tracked.txt', 'unused.md'], 'the authorized maximum set travels unchanged');
    const captured = cli('manifest_compare', captureRequest.data.request.data);
    assert.equal(captured.ok, true, JSON.stringify(captured.error));
    assert.deepEqual(captured.data.entries.map((entry) => entry.path), ['tracked.txt']);
    const compareRequest = cli('build_manifest_compare', { captured: captured.data, cwd: workspace });
    assert.equal(compareRequest.ok, true, JSON.stringify(compareRequest.error));
    const recompared = cli('manifest_compare', compareRequest.data.request.data);
    assert.equal(recompared.ok, true, JSON.stringify(recompared.error));
    assert.equal(recompared.data.entryCount, 1);
    // Non-force cleanup requires a clean workspace: restore it first, as the run would after commit.
    git(workspace, ['reset', '-q', '--hard']);
    const cleaned = cli('workspace_cleanup', { receipt: created.data.receipt, cwd: repo.root });
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(repo.bare, { recursive: true, force: true });
  }
});

test('Issue #105 required_evidence_check makes a nonexistent required file an assembly error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-105-evidence-'));
  try {
    fs.writeFileSync(path.join(dir, 'CONTRACT.md'), 'present\n');
    fs.mkdirSync(path.join(dir, 'skills'));
    const present = cli('required_evidence_check', { cwd: dir, requiredEvidence: [
      { source: 'CONTRACT.md', kind: 'file', identity: SHA },
      { source: path.join(dir, 'CONTRACT.md'), kind: 'file', identity: 'HEAD:CONTRACT.md' },
      { source: 'PR body', kind: 'github', identity: 'tetsuh/pi-tidd-agents#104@' + 'a'.repeat(40) },
      { source: 'effective.diff', kind: 'git', identity: `sha256:${SHA}` },
    ] });
    assert.equal(present.ok, true, JSON.stringify(present.error));
    assert.deepEqual(present.data, { checked: 2, skipped: 2 });
    // The PR #104 Terra invocation 1 set: a file the repository does not have.
    const missing = cli('required_evidence_check', { cwd: dir, requiredEvidence: [
      { source: 'CONTRACT.md', kind: 'file', identity: SHA },
      { source: 'package-lock.json', kind: 'file', identity: SHA },
    ] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'invalid_request');
    assert.equal(missing.error.phase, 'required_evidence_check');
    assert.deepEqual(missing.error.details, { subcheck: 'required_evidence_presence', observed: 'package-lock.json' });
    assert.match(missing.error.message, /package-lock\.json/);
    // A directory is not a file the gate can read completely.
    const directory = cli('required_evidence_check', { cwd: dir, requiredEvidence: [{ source: 'skills', kind: 'file', identity: SHA }] });
    assert.equal(directory.ok, false);
    assert.equal(directory.error.details.subcheck, 'required_evidence_presence');
    assert.equal(directory.error.details.observed, 'skills');
    // The boundary's own shape rule runs first, in its own vocabulary.
    const malformed = cli('required_evidence_check', { cwd: dir, requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file' }] });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, 'invalid_request');
    assert.equal(malformed.error.details.subcheck, 'required_evidence_shape');
    const empty = cli('required_evidence_check', { cwd: dir, requiredEvidence: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.details.subcheck, 'required_evidence_shape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue #105 CL-D61 records the builders, the check, and the CL-D56 widening', () => {
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D61 — The manifest requests are built and the required-evidence set is checked before any gate');
  assert.ok(record, 'CL-D61 must exist');
  for (const field of ['*Decision ID:* CL-D61', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D61 must carry ${field}`);
  assert.match(record, /issues\/105#issuecomment-5525979290/);
  assert.match(record, /`build_manifest_capture`/);
  assert.match(record, /`build_manifest_compare`/);
  assert.match(record, /`required_evidence_check`/);
  assert.match(record, /widens CL-D56's builder family from five to seven/);
  assert.match(sectionOf(contract, '## CL-D56 — Package-owned builders construct the documents the boundary checks'), /CL-D61 later added the two `manifest_compare` builders under its own decision/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D61').map((clause) => clause.id).sort(), ['CL-D61-map', 'CL-D61-shared', 'CL-D61-tests']);
});

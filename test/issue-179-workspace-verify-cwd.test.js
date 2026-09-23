'use strict';

// Issue #179 (CL-D88) — exact-autofix attempt 6 on PR #178 stopped BLOCKED in preflight: the parent composed the
// workspace verification with the operator checkout as `cwd`, and `workspace_verify` refused it with
// `identity_mismatch`. `build_workspace_verify` took `cwd` beside `created` and passed it through, although
// `created.path` already names the run-owned workspace. The builder now derives it and refuses one supplied.
//
// TDD provenance: behavioural RED — the builder and the packaged CLI accept a supplied `cwd` before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readText, sectionOf } = require('./helpers');
const { buildWorkspaceVerify } = require('../skills/closed-loop-pr/helpers/builders');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const OID = 'a'.repeat(40);
function receipt() { return { version: 1, id: 'run-1', root: '/run', storedPath: '/run/.cleanup-receipt.json', creationIdentity: { kind: 'linked', path: '/run/workspace' } }; }
function created() { return { path: '/run/workspace', head: OID, tree: 'b'.repeat(40), root: '/run', kind: 'linked', receipt: receipt(), cleanupAllowed: true }; }
function cli(operation, data) {
  return JSON.parse(spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' }).stdout);
}

test('Issue #179 the verify request runs in the workspace the run created', () => {
  const built = buildWorkspaceVerify({ created: created() });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.data.request.data.cwd, '/run/workspace', 'cwd is created.path');
  const viaCli = cli('build_workspace_verify', { created: created() });
  assert.equal(viaCli.ok, true, JSON.stringify(viaCli));
  assert.equal(viaCli.data.request.data.cwd, '/run/workspace');
});

test('Issue #179 a cwd supplied beside created is refused, on both surfaces', () => {
  // The PR #178 shape: the operator checkout where the workspace belongs.
  const direct = buildWorkspaceVerify({ created: created(), cwd: '/home/operator/checkout' });
  assert.deepEqual([direct.ok, direct.error?.code, direct.error?.phase], [false, 'invalid_request', 'build'], JSON.stringify(direct));
  // Even the right path is refused: the builder has one source for it.
  const same = buildWorkspaceVerify({ created: created(), cwd: '/run/workspace' });
  assert.equal(same.ok, false, 'a second source for one fact is refused even when it agrees');
  const viaCli = cli('build_workspace_verify', { created: created(), cwd: '/home/operator/checkout' });
  assert.deepEqual([viaCli.ok, viaCli.error?.code, viaCli.error?.phase], [false, 'invalid_request', 'cli'], JSON.stringify(viaCli));
});

test('Issue #179 a workspace path that cannot be a cwd is refused', () => {
  for (const [label, pathValue] of [['relative', 'run/workspace'], ['NUL', '/run/work\u0000space'], ['lone surrogate', '/run/\ud800']]) {
    const result = buildWorkspaceVerify({ created: { ...created(), path: pathValue } });
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'invalid_request', label);
  }
});

test('Issue #179 the map, the CLI table, and CL-D88 state the input set', () => {
  // ADV-180-VERIFY-INPUTS-001: the row and the builder paragraph state the whole input set, `transition` included.
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.match(map, /\| Construct the verify request from the workspace it verifies \(CL-D56\) \| `build_workspace_verify` \| `created` \(data of `workspace_create`\) and optionally `transition`; the request runs in `created\.path`, and a `cwd` beside it is refused \(CL-D88\) \|/);
  assert.match(map, /`build_workspace_verify` takes `created` and optionally `transition`, and composes the request to run in `created\.path`; it takes no `cwd` \(CL-D88\)\./);
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /build_workspace_verify: \{ required: \['created'\], optional: \['transition'\] \}/);
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D88 — The workspace verification runs in the workspace the run created');
  assert.ok(record, 'CL-D88 must exist');
  assert.match(record, /issues\/179#issuecomment-5795735529/);
});

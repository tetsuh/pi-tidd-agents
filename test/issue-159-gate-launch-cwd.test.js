'use strict';

// Issue #159 (CL-D82). `references/autofix.md` and the addendum state that the gates run at the isolated workspace's
// cwd, and `build_gate_launch` emitted no `cwd` at all, so pi-subagents resolved the child's cwd from the caller's
// context — the operator checkout at the immutable baseline. After the writer commits a correction the two trees
// differ, so a route-to-Sol gate would read the uncorrected tree while the procedure claimed otherwise. The builder
// now takes the created workspace, optional because review-only has none, and emits its path as the child's `cwd`
// (owner choice B, issues/159#issuecomment-5748464962).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath, cliSchemas } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const CREATED = Object.freeze({
  kind: 'linked',
  path: '/tmp/pi-autofix-helper-test/workspace',
  root: '/tmp/pi-autofix-helper-test',
  head: OID,
  tree: 'b'.repeat(40),
  cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' },
});

function correlation(gate) {
  return { repository: 'o/r', number: 159, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
}
function expectationFor(gate) {
  const built = helpers.buildGateExpectation({ workflow: 'pr', correlation: correlation(gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  return built.data;
}
function completeVolatile(gate) {
  const envelope = {
    target: { repository: 'o/r', number: 159, mode: 'autofix', gate, baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' },
    fingerprints: { issue_spec: SHA, pr_base: 'b'.repeat(40), pr_tree: 'c'.repeat(40), pr_head: OID, pr_diff: SHA, pr_commits: SHA, snapshot: 'd'.repeat(64) },
    body: 'body',
    languageProfile: 'conversation: ja; GitHub issue / pull request: en',
    acceptanceCriteria: ['AC1'], history: { unresolved: [], reopened: [], settled: [] },
    diff: 'diff --git a/a b/a' + String.fromCharCode(10),
  };
  if (gate === 'adversarial') { envelope.decisions = []; envelope.comments = []; }
  return envelope;
}

function withExpectationFile(gate, run) {
  const dir = temp('issue-159-launch-');
  try {
    const expectation = expectationFor(gate);
    const expectationPath = path.join(dir, `${gate}.json`);
    fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.expected, null, 2)}\n`);
    run({ expectation, expectationPath, volatile: completeVolatile(gate) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Issue #159 a gate launch built with the created workspace runs in it', () => {
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    withExpectationFile(gate, (data) => {
      const built = helpers.buildGateLaunch({ ...data, created: CREATED });
      assert.equal(built.ok, true, `${gate}: ${JSON.stringify(built.error)}`);
      assert.equal(built.data.request.cwd, CREATED.path, `${gate}: the gate child runs in the run's own workspace`);
      // The one field added, and nothing else: the launch is otherwise what CL-D68 fixed.
      assert.deepEqual(Object.keys(built.data.request).sort(), ['acceptance', 'agent', 'async', 'context', 'cwd', 'outputMode', 'outputSchema', 'task'], gate);
    });
  }
});

test('Issue #159 a gate launch built without a workspace carries no cwd', () => {
  // Review-only has no workspace: it reviews the operator checkout, and the child inherits that cwd as before.
  withExpectationFile('adversarial', (data) => {
    const built = helpers.buildGateLaunch(data);
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.equal(Object.hasOwn(built.data.request, 'cwd'), false, 'no workspace, no cwd');
    assert.deepEqual(Object.keys(built.data.request).sort(), ['acceptance', 'agent', 'async', 'context', 'outputMode', 'outputSchema', 'task']);
  });
});

test('Issue #159 the workspace the builder takes is producer output, and a written one is refused', () => {
  withExpectationFile('adversarial', (data) => {
    for (const [label, created] of [
      ['a hand-made object', { path: '/tmp/w' }],
      ['a clone fallback', { ...CREATED, kind: 'clone', cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable', receipt: undefined }],
      ['null', null],
    ]) {
      const refused = helpers.buildGateLaunch({ ...data, created });
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      assert.equal(refused.error.phase, 'build', label);
    }
    // A relative or control-bearing workspace path is refused as the writer launch refuses it (CL-D81).
    for (const candidate of ['relative/workspace', `/tmp/w${String.fromCharCode(0)}`, '/tmp/w\ud800']) {
      const refused = helpers.buildGateLaunch({ ...data, created: { ...CREATED, path: candidate } });
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'invalid_request'], JSON.stringify(candidate));
    }
  });
});

test('Issue #159 the packaged CLI carries the workspace into the gate launch', () => {
  withExpectationFile('adversarial', (data) => {
    const run = (extra) => {
      const result = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation: 'build_gate_launch', data: { ...data, ...extra } }), encoding: 'utf8' });
      return JSON.parse(result.stdout);
    };
    const withWorkspace = run({ created: CREATED });
    assert.equal(withWorkspace.ok, true, JSON.stringify(withWorkspace.error));
    assert.equal(withWorkspace.data.request.cwd, CREATED.path);
    const without = run({});
    assert.equal(without.ok, true, JSON.stringify(without.error));
    assert.equal(Object.hasOwn(without.data.request, 'cwd'), false);
    // The CLI's own input table names it optional, beside the three CL-D68 inputs.
    assert.deepEqual(cliSchemas().build_gate_launch, ['expectation', 'expectationPath', 'volatile']);
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /build_gate_launch: \{ required: \['expectation', 'expectationPath', 'volatile'\], optional: \['created'\] \}/);
  });
});

test('Issue #159 the procedure states where each mode runs its gates', () => {
  // The map gains the input; the addendum's own cwd sentence, true only now, names how a gate child gets there. The
  // two authority files sit at their ceilings, so the statement is carried where it already belonged.
  const map = readText('skills/closed-loop-pr/references/autofix.md');
  assert.ok(map.includes('| Gate launch request (CL-D2, CL-D68, CL-D82) | `build_gate_launch` | `expectation` (data of `build_gate_expectation`), `expectationPath`, `volatile`, `created` (data of `workspace_create`) |'), 'the map declares the new input');
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.ok(addendum.includes('uses exact workspace cwd/identity, gate children via `created` (CL-D82)'), 'the addendum names how a gate child reaches the workspace');
  const record = readText('CONTRACT.md');
  assert.ok(record.includes('## CL-D82 — The gate launch names the workspace its child runs in'), 'CL-D82 must exist');
});

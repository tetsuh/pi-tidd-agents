'use strict';

// Issue #111 (CL-D68) — the two gate documents the parent still assembled by hand are packaged:
// `gate_result_read` reads the envelope from the runner's own status record, so the parent never
// chooses an output path; `build_gate_launch` composes the launch request from the installed
// package's authority files, so a hand-edited schema, a parent-chosen `output:` file, or free-text
// envelope prose is unrepresentable. `operator_capture` records the helper path and blocks a helper
// resolved inside the target; `workspace_cleanup` refuses a cwd inside the workspace it removes;
// an unknown operation names the nearest known ones. Six exact-autofix runs on #113, #121, and
// #122 stopped before the writer on these hand-assembled steps.
//
// TDD provenance: pre-implementation compile/contract RED, recorded with
// `node --test test/issue-111-gate-read-launch.test.js` at 0 passes / 9 failures before
// `launch.js`, the operator and cleanup changes, and the prose existed. The behavioral tests here run
// the operations against fixture run records, fixture repositories, and the package's own files.
// That local output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, readJson, repoPath, sectionOf, cliSchemas } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const OID = 'a'.repeat(40), SHA = '1'.repeat(64), RUN = '7305b50a-2708-4e55-8364-d72f11197fbe';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}
function correlation(workflow, gate) {
  return { repository: 'o/r', number: 111, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
}
function envelopeFor(workflow, gate) {
  return { schemaVersion: 2, correlation: correlation(workflow, gate), verdict: 'MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }], findings: [], confirmations: [], decisions: [], adversarialResults: gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }] : [] };
}
function expectationFor(workflow, gate) {
  const built = helpers.buildGateExpectation({ workflow, correlation: correlation(workflow, gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  return built.data;
}
// A runner record as pi-subagents writes it: status.json names the step's structuredOutputPath.
function runRecord(root, { runId = RUN, state = 'complete', stepStatus = 'complete', envelope = envelopeFor('pr', 'adversarial'), outputText, withPath = true } = {}) {
  // `stepStatus: undefined` passed explicitly still defaults; callers that want no status field pass `null`.
  const dir = path.join(root, runId); fs.mkdirSync(path.join(dir, 'structured-output', 'x'), { recursive: true });
  const structuredOutputPath = path.join(dir, 'structured-output', 'x', 'output.json');
  if (outputText === null) fs.rmSync(structuredOutputPath, { force: true });
  else fs.writeFileSync(structuredOutputPath, outputText === undefined ? `${JSON.stringify(envelope, null, 2)}\n` : outputText);
  const step = { agent: 'tidd-adversarial-reviewer' };
  if (stepStatus !== null) step.status = stepStatus;
  if (withPath) step.structuredOutputPath = structuredOutputPath;
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId, state, steps: [step] }));
  return { dir, structuredOutputPath };
}

test('Issue #111 gate_result_read returns the designated envelope from the runner status and ignores any parent-chosen file', () => {
  const root = temp('i111-runs-');
  try {
    const envelope = envelopeFor('pr', 'adversarial');
    const { structuredOutputPath } = runRecord(root, { envelope });
    const parentChosen = path.join(root, 'sol-result.json'); fs.writeFileSync(parentChosen, '');
    const read = helpers.readGateResult({ runId: RUN, runsRoot: root });
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.deepEqual(read.data.envelope, envelope);
    assert.equal(read.data.structuredOutputPath, structuredOutputPath);
    assert.equal(read.data.statusPath, path.join(root, RUN, 'status.json'));
    assert.equal(read.data.bytes, Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`));
    assert.equal(read.data.state, 'complete');
    // Read, then validate: the read envelope is the declared `structured:gate_result` shape.
    const expected = expectationFor('pr', 'adversarial').expected;
    const validated = helpers.validateGateResult(read.data.envelope, expected);
    assert.equal(validated.ok, true, JSON.stringify(validated.error));
    const viaCli = cli('gate_result_read', { runId: RUN, runsRoot: root });
    assert.equal(viaCli.ok, true, JSON.stringify(viaCli.error));
    assert.deepEqual(viaCli.data.envelope, envelope);
    assert.deepEqual(cliSchemas().gate_result_read, ['runId'], 'the request names a run, never a path');
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /gate_result_read: \{ required: \['runId'\], optional: \['runsRoot'\] \}/, 'runsRoot is the fixture override, the only optional field');
    assert.equal(fs.statSync(parentChosen).size, 0, 'the parent-chosen file stays empty and unread');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #111 gate_result_read fails closed with a distinct code and the path for every transport state', () => {
  const root = temp('i111-runs-');
  try {
    const expectFail = (data, code, pathKey) => {
      const result = helpers.readGateResult(data);
      assert.equal(result.ok, false, `${code}: ${JSON.stringify(result)}`);
      assert.equal(result.error.code, code);
      assert.equal(result.error.phase, 'gate_result_read');
      if (pathKey) assert.ok(typeof result.error.details?.[pathKey] === 'string' && result.error.details[pathKey].length > 0, `${code} names ${pathKey}`);
      return result;
    };
    expectFail({ runId: 'not-a-run-id', runsRoot: root }, 'invalid_request');
    expectFail({ runId: RUN, runsRoot: root }, 'status_absent', 'statusPath');
    fs.mkdirSync(path.join(root, RUN), { recursive: true }); fs.writeFileSync(path.join(root, RUN, 'status.json'), '{');
    expectFail({ runId: RUN, runsRoot: root }, 'status_unparsable', 'statusPath');
    runRecord(root, { runId: RUN, state: 'running', stepStatus: 'running' });
    expectFail({ runId: RUN, runsRoot: root }, 'run_incomplete', 'statusPath');
    fs.writeFileSync(path.join(root, RUN, 'status.json'), JSON.stringify({ runId: '0'.repeat(8) + RUN.slice(8), state: 'complete', steps: [] }));
    expectFail({ runId: RUN, runsRoot: root }, 'run_mismatch', 'statusPath');
    runRecord(root, { withPath: false });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_unrecorded', 'statusPath');
    // CONV-123-INCOMPLETE-STEP-READ: a completed run whose selected step failed or is still running, with a valid
    // envelope at its path, is not a result.
    for (const stepStatus of ['failed', 'running', 'cancelled']) { runRecord(root, { stepStatus }); const result = expectFail({ runId: RUN, runsRoot: root }, 'step_incomplete', 'structuredOutputPath'); assert.equal(result.error.details.stepStatus, stepStatus); }
    runRecord(root, { stepStatus: null }); expectFail({ runId: RUN, runsRoot: root }, 'step_incomplete', 'structuredOutputPath');
    runRecord(root, { outputText: null });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_absent', 'structuredOutputPath');
    runRecord(root, { outputText: '' });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_empty', 'structuredOutputPath');
    runRecord(root, { outputText: ' \n' });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_empty', 'structuredOutputPath');
    runRecord(root, { outputText: '{"schemaVersion": 2,' });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_unparsable', 'structuredOutputPath');
    runRecord(root, { outputText: '[]' });
    expectFail({ runId: RUN, runsRoot: root }, 'designated_output_unparsable', 'structuredOutputPath');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The composer's block sources, as the shared contract and the root Skills declare them.
const EVERY_GATE = ['skills/closed-loop-shared/references/gate-contract.md', '#### Every-gate invariant payload block (CL-D2)'];
const SOL_ONLY = ['skills/closed-loop-shared/references/gate-contract.md', '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)'];
const ROLE_BLOCKS = { issue: ['skills/closed-loop-issue/SKILL.md', '### Issue gate role-authority blocks (CL-D2)'], pr: ['skills/closed-loop-pr/SKILL.md', '### PR gate role-authority blocks (CL-D2)'] };
const block = ([file, heading]) => sectionOf(readText(file), heading);
function roleSentence(workflow, nickname) {
  const line = block(ROLE_BLOCKS[workflow]).split('\n').find((candidate) => candidate.startsWith(`- \`${workflow === 'issue' ? 'Issue' : 'PR'} ${nickname} role-authority block\`: \``));
  assert.ok(line, `${workflow} ${nickname} role block line`);
  return line.slice(line.indexOf('`: `') + 4, -1);
}
function composed(workflow, gate, volatile, expectationPath) {
  const parts = [block(EVERY_GATE)];
  if (gate === 'adversarial') parts.push(block(SOL_ONLY));
  if (gate !== 'convergence') parts.push(`${workflow === 'issue' ? 'Issue' : 'PR'} ${gate === 'adversarial' ? 'Sol' : 'Terra'} role-authority block: ${roleSentence(workflow, gate === 'adversarial' ? 'Sol' : 'Terra')}`);
  parts.push(`## Volatile envelope\n\n\`\`\`json\n${JSON.stringify(volatile, null, 2)}\n\`\`\``);
  parts.push(`Expectation file: ${expectationPath}\nPackaged validator: node ${CLI} (operation gate_result_validate, CL-D65)`);
  return `${parts.join('\n\n')}\n`;
}

test('Issue #111 build_gate_launch composes the request from the package and cannot carry another schema, an output file, or envelope prose', () => {
  const dir = temp('i111-launch-');
  try {
    const volatile = { targetBody: 'body', fingerprints: { pr_head: OID }, decisions: [], comments: [], assigned: [] };
    for (const [workflow, gate, role] of [['pr', 'adversarial', 'tidd-adversarial-reviewer'], ['pr', 'safety', 'tidd-safety-reviewer'], ['issue', 'decision-drift', 'tidd-drift-reviewer'], ['issue', 'adversarial', 'tidd-adversarial-reviewer'], ['pr', 'convergence', 'tidd-convergence-reviewer']]) {
      const expectation = expectationFor(workflow, gate);
      const expectationPath = path.join(dir, `${workflow}-${gate}.json`);
      fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.expected, null, 2)}\n`);
      const built = helpers.buildGateLaunch({ expectation, expectationPath, volatile });
      assert.equal(built.ok, true, `${workflow}/${gate}: ${JSON.stringify(built.error)}`);
      const { request, blocks } = built.data;
      assert.equal(request.agent, role, `${workflow}/${gate} role`);
      assert.deepEqual(Object.keys(request).sort(), ['acceptance', 'agent', 'async', 'context', 'outputMode', 'outputSchema', 'task'], `${workflow}/${gate}: exactly the launch fields, no output file`);
      assert.deepEqual({ context: request.context, async: request.async, outputMode: request.outputMode, acceptance: request.acceptance }, { context: 'fresh', async: true, outputMode: 'inline', acceptance: false });
      assert.deepEqual(request.outputSchema, gateResult.SCHEMA, 'the builder schema byte for byte');
      assert.notEqual(request.outputSchema, expectation.outputSchema, 'a detached copy, never an alias');
      assert.equal(request.task, composed(workflow, gate, volatile, expectationPath), `${workflow}/${gate}: the task is exactly the verbatim blocks, the volatile envelope, and the two machine lines`);
      const expectedBlocks = [EVERY_GATE, ...(gate === 'adversarial' ? [SOL_ONLY] : []), ...(gate === 'convergence' ? [] : [ROLE_BLOCKS[workflow]])].map(([file, heading]) => ({ file, heading, sha256: sha256(block([file, heading])) }));
      assert.deepEqual(blocks.map(({ file, heading, sha256: digest }) => ({ file, heading, sha256: digest })), expectedBlocks, `${workflow}/${gate}: block digests`);
      assert.equal(built.data.packageRoot, repoPath('.'), 'blocks are read from the installed package root');
    }
    const expectation = expectationFor('pr', 'adversarial');
    const expectationPath = path.join(dir, 'pr-adversarial.json');
    const fail = (data, code) => { const result = helpers.buildGateLaunch(data); assert.equal(result.ok, false, code); assert.equal(result.error.code, code, JSON.stringify(result.error)); assert.equal(result.error.phase, 'build'); };
    const edited = JSON.parse(JSON.stringify(expectation)); edited.outputSchema.properties.extra = { type: 'string' };
    fail({ expectation: edited, expectationPath, volatile }, 'schema_mismatch');
    fs.writeFileSync(expectationPath, `${JSON.stringify({ ...expectation.expected, assignedFindings: [{ findingId: 'ADV-111-X', blockerKey: 'k' }] })}\n`);
    fail({ expectation, expectationPath, volatile }, 'expectation_file_mismatch');
    fail({ expectation, expectationPath: path.join(dir, 'missing.json'), volatile }, 'expectation_file_absent');
    fail({ expectation: { ...expectation, expected: { ...expectation.expected, workflow: 'wiki' } }, expectationPath, volatile }, 'invalid_request');
    fail({ expectation, expectationPath, volatile: 'free text' }, 'invalid_request');
    // CONV-123-ROOT-GATE-LAUNCH: a gate outside its root is rejected by both builders, from the validator's own table.
    for (const [workflow, gate] of [['issue', 'safety'], ['pr', 'decision-drift']]) {
      const wrongPair = helpers.buildGateExpectation({ workflow, correlation: correlation(workflow, gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
      assert.equal(wrongPair.ok, false, `${workflow}/${gate} expectation`); assert.equal(wrongPair.error.code, 'gate_outside_root', JSON.stringify(wrongPair.error));
      const forged = JSON.parse(JSON.stringify(expectation)); forged.expected.workflow = workflow; forged.expected.correlation.gate = gate;
      fail({ expectation: forged, expectationPath, volatile }, 'gate_outside_root');
    }
    fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.expected, null, 2)}\n`);
    const viaCli = cli('build_gate_launch', { expectation, expectationPath, volatile });
    assert.equal(viaCli.ok, true, JSON.stringify(viaCli.error));
    assert.equal('output' in viaCli.data.request, false);
    assert.deepEqual(cliSchemas().build_gate_launch, ['expectation', 'expectationPath', 'volatile']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #111 the composer maps gates to roles from one table that the vocabulary source pins', () => {
  const source = readText('skills/closed-loop-pr/helpers/launch.js');
  const vocab = readJson('test/records/workflow-vocabulary.json');
  const expected = Object.fromEntries(vocab.roles.filter((role) => role.gate).map((role) => [role.gate, role.name]));
  const match = source.match(/const ROLE_BY_GATE = Object\.freeze\((\{[^}]+\})\)/);
  assert.ok(match, 'ROLE_BY_GATE is one frozen literal');
  assert.deepEqual(JSON.parse(match[1].replace(/'/g, '"').replace(/(\w[\w-]*):/g, '"$1":').replace(/"?'?([a-z-]+)'?"?:/g, '"$1":')), expected);
});

test('Issue #111 operator_capture records the helper path and blocks a helper resolved inside the target', () => {
  const trust = helpers.helperTrust(repoPath('.'));
  assert.equal(trust.helperPath, fs.realpathSync.native(repoPath('skills/closed-loop-pr/helpers')));
  assert.equal(trust.helperInsideTarget, true, 'this repository is its own package: the helper resolves inside it');
  assert.equal(helpers.helperTrust(temp('i111-elsewhere-')).helperInsideTarget, false);
  const identity = { repository: 'o/r', prNumber: 111, lifecycle: 'OPEN', baseOid: 'b'.repeat(40), publicHead: OID, headRepository: 'o/r', headBranch: 'main', originFetch: 'x', originPush: 'x' };
  const captured = helpers.captureOperatorCheckout({ cwd: repoPath('.'), identity });
  assert.equal(captured.ok, false);
  assert.equal(captured.error.code, 'helper_inside_target', JSON.stringify(captured.error));
  assert.equal(captured.error.details.helperPath, trust.helperPath);
});

function fixtureRepository() {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = temp('i111-repo-'); const bare = temp('i111-origin-');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 111 Test']); git(root, ['config', 'user.email', 'issue111@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n'); git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
  git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

test('Issue #111 workspace_cleanup and its builder refuse a cwd inside the workspace being removed', async () => {
  const repository = fixtureRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const built = helpers.buildWorkspaceCleanup({ created: created.data, cwd: created.data.path });
    assert.equal(built.ok, false); assert.equal(built.error.code, 'cleanup_cwd_inside_workspace', JSON.stringify(built.error)); assert.equal(built.error.phase, 'build');
    const nested = helpers.buildWorkspaceCleanup({ created: created.data, cwd: path.join(created.data.path, 'sub') });
    assert.equal(nested.error.code, 'cleanup_cwd_inside_workspace');
    const direct = await helpers.cleanupWorkspace(created.data.receipt, created.data.path);
    assert.equal(direct.ok, false); assert.equal(direct.error.code, 'cleanup_cwd_inside_workspace', JSON.stringify(direct.error));
    assert.ok(fs.existsSync(created.data.path), 'nothing was removed');
    // CONV-123-SYMLINK-CLEANUP-CWD: a symlink alias of the workspace, or a path below it, is the same cwd.
    if (process.platform !== 'win32') {
      const aliasParent = temp('i111-alias-'); const alias = path.join(aliasParent, 'ws'); fs.symlinkSync(created.data.path, alias);
      try {
        for (const cwd of [alias, path.join(alias, 'sub')]) { const viaAlias = await helpers.cleanupWorkspace(created.data.receipt, cwd); assert.equal(viaAlias.ok, false); assert.equal(viaAlias.error.code, 'cleanup_cwd_inside_workspace', `${cwd}: ${JSON.stringify(viaAlias.error)}`); }
        assert.ok(fs.existsSync(created.data.path), 'nothing was removed through the alias');
      } finally { fs.rmSync(aliasParent, { recursive: true, force: true }); }
    }
    const proper = helpers.buildWorkspaceCleanup({ created: created.data, cwd: repository.root });
    assert.equal(proper.ok, true, JSON.stringify(proper.error));
    const removed = await helpers.cleanupWorkspace(proper.data.request.data.receipt, proper.data.request.data.cwd);
    assert.equal(removed.ok, true, JSON.stringify(removed.error));
  } finally { fs.rmSync(repository.root, { recursive: true, force: true }); fs.rmSync(repository.bare, { recursive: true, force: true }); }
});

test('Issue #111 an unknown operation names the nearest known operations', () => {
  const result = cli('writability_recheck', {});
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid_request');
  assert.match(result.error.message, /^unknown operation writability_recheck; nearest: writability, /);
  assert.equal(result.error.details.nearest.length, 3);
  assert.equal(result.error.details.nearest[0], 'writability');
  for (const name of result.error.details.nearest) assert.ok(Object.hasOwn(cliSchemas(), name), `${name} is a known operation`);
});

test('Issue #111 the invocation map, the transport section, and the README name the operations and the host-trust rule', () => {
  const map = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map);
  assert.ok(map.includes('| Gate launch request (CL-D2, CL-D68) | `build_gate_launch` | `expectation` (data of `build_gate_expectation`), `expectationPath`, `volatile` |'));
  assert.ok(map.includes('| Every gate result, before `gate_result_validate` (CL-D58, CL-D68) | `gate_result_read` | `runId` |'));
  assert.match(map, /Run the CLI from the installed package, never from the reviewed checkout: `operator_capture` records `helperPath` and fails closed with `helper_inside_target` \(CL-D68\)\./);
  assert.match(map, /`build_gate_launch` reads the payload blocks from that package and emits no `output` field: pass its request to the subagent tool unchanged and read the result with `gate_result_read` by run id/);
  const transport = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '### Structured gate result transport (CL-D36)');
  assert.match(transport, /the parent reads it from that path after completion through packaged `gate_result_read`, which resolves the path from the run id \(CL-D68\)/);
  assert.match(transport, /the launch request is composed by packaged `build_gate_launch` \(CL-D68\)/);
  assert.match(readText('README.md'), /CL-D68 packages the gate launch request and the designated-output read \(`build_gate_launch`, `gate_result_read`\), records the helper path, and blocks a helper resolved inside the target/);
});

test('Issue #111 CL-D68 records the widening and the manifest pins it', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D68 — The gate launch request and the designated-output read are packaged');
  assert.ok(record, 'CL-D68 must exist');
  for (const field of ['*Decision ID:* CL-D68', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D68 must carry ${field}`);
  assert.match(record, /issues\/111#issuecomment-5617260994/);
  assert.match(record, /issues\/111#issuecomment-5617536570/);
  assert.match(record, /widens CL-D56's builder family by a read-only composer whose only I\/O is reading the installed package's own authority files/);
  assert.match(record, /the parent never chooses the path/);
  assert.match(record, /`validation_run` \(#64 item 1\) is deferred to its own decision/);
  // The raise, with its property asserted at the raise: the seven files measured 140,311 bytes then.
  const CL_D68_BASELINE_BYTES = 140311;
  assert.match(record, /raises the authority ceiling once more, from 140,000 to 150,000 bytes: the seven authority files measured 140,311 bytes/);
  assert.ok(CL_D68_BASELINE_BYTES > 140000 && 150000 - CL_D68_BASELINE_BYTES > 8000, `the raise left ${150000 - CL_D68_BASELINE_BYTES} bytes`);
  for (const file of ['test/package.test.js', 'test/issue-73-authority-budget.test.js', 'test/issue-87-authority-floor.test.js', 'test/issue-87-addendum-split.test.js', 'test/issue-100-gate-ids-v2.test.js']) assert.match(readText(file), /assert\.ok\(total < 150000,/, `${file} asserts the raised ceiling`);
  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D68').map((clause) => clause.id).sort(), ['CL-D68-map', 'CL-D68-record', 'CL-D68-tests', 'CL-D68-transport']);
  assert.ok(fs.existsSync(repoPath('test/issue-111-gate-read-launch.test.js')));
});

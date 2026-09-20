'use strict';

// Issue #152. The writer's launch request was the last one the parent composed by hand, and it went wrong twice in
// one day: PR #149 run 1 carried `preflight`, which pi-subagents accepts only beside a workflow script, and the run
// before it carried an `acceptance.evidence` list of kinds pi-subagents does not know (#150). `build_writer_launch`
// composes it instead (CL-D81), and the cases below check the built request against the receiver's own validators,
// not only against this package's predicates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath } = require('./helpers');

const CREATED = Object.freeze({
  kind: 'linked',
  path: '/tmp/pi-autofix-helper-test/workspace',
  root: '/tmp/pi-autofix-helper-test',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' },
});
const TASK = 'Correct ADV-149-CONTROL-CHARACTER-COLLISION in the publisher, with its regression.';
const build = (data) => helpers.buildWriterLaunch({ created: CREATED, task: TASK, ...data });

test('Issue #152 the builder composes the writer launch, and the parent states only the task', () => {
  const built = build({});
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const request = built.data.request;
  assert.equal(request.agent, 'tidd-autofix-worker', 'the role name, never a model');
  assert.equal(request.task, TASK);
  assert.equal(request.cwd, CREATED.path, 'the workspace the run created');
  // The fields CL-D80 fixed, now emitted rather than typed by the parent.
  assert.equal(request.acceptance, false);
  assert.equal(request.timeoutMs, 3600000);
  assert.equal(request.checkpointBeforeDeadlineMs, 600000);
  assert.equal(request.async, true);
  assert.equal(request.context, 'fork');
  assert.equal(request.outputMode, 'inline');
  // The complete set: dropping a field the builder must emit, or adding one, fails here.
  assert.deepEqual(Object.keys(request).sort(), ['acceptance', 'agent', 'async', 'checkpointBeforeDeadlineMs', 'context', 'cwd', 'outputMode', 'task', 'timeoutMs']);
});

// A clone fallback as `workspace_create` returns it: `receipt` is absent, not present and undefined. A spread of
// `receipt: undefined` leaves an own key behind, and the declared shape then refuses the object one layer earlier,
// so the clone rule itself would never run (ADV-152-CLONE-CASE-NOT-DISCRIMINATING).
const CLONE = Object.freeze({
  kind: 'clone',
  path: '/tmp/pi-autofix-helper-test/clone',
  root: '/tmp/pi-autofix-helper-test',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  cleanupAllowed: false,
  retained: true,
  fallbackReason: 'linked_unavailable',
});

test('Issue #152 the builder refuses what it cannot compose from, each for its own reason', () => {
  // Every case names the code it must be refused with: `invalid_request` is the builder's own rule, and
  // `input_shape_mismatch` is the declared CL-D44 shape, so a case refused one layer earlier than it claims fails.
  for (const [label, code, data] of [
    ['no task', 'invalid_request', { task: undefined }],
    ['an empty task', 'invalid_request', { task: '  ' }],
    ['a task that is not a string', 'invalid_request', { task: 42 }],
    ['a task carrying a NUL byte', 'invalid_request', { task: `fix${String.fromCharCode(0)} it` }],
    ['a task carrying a lone surrogate', 'invalid_request', { task: 'fix \ud800 it' }],
    ['a clone fallback workspace', 'invalid_request', { created: CLONE }],
    ['a workspace path carrying a NUL byte', 'invalid_request', { created: { ...CREATED, path: `/tmp/w${String.fromCharCode(0)}/x` } }],
    ['a workspace path carrying a lone surrogate', 'invalid_request', { created: { ...CREATED, path: '/tmp/w\ud800' } }],
    ['a relative workspace path', 'invalid_request', { created: { ...CREATED, path: '../../etc' } }],
    ['no workspace', 'input_shape_mismatch', { created: undefined }],
    ['a linked workspace without its receipt', 'input_shape_mismatch', { created: { ...CLONE, kind: 'linked', cleanupAllowed: true } }],
  ]) {
    const refused = helpers.buildWriterLaunch({ created: CREATED, task: TASK, ...data });
    assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
    assert.deepEqual([refused.error.code, refused.error.phase], [code, 'build'], label);
  }
  // The clone object is a workspace the shape accepts: the refusal above is the builder's rule, not the shape's.
  assert.equal(helpers.inputShapeProblem('build_writer_launch', { created: CLONE, task: TASK }), null);
});

test('Issue #152 the parent cannot add a field to the built request', () => {
  // The two fields that stopped PR #149's runs are not among the keys the builder emits, and the builder takes no
  // input that could introduce them.
  const request = build({}).data.request;
  for (const key of ['preflight', 'workflowScript', 'workflowScriptPath', 'acceptanceReport', 'evidence']) {
    assert.equal(Object.hasOwn(request, key), false, `the request carries no ${key}`);
  }
  const withExtra = helpers.buildWriterLaunch({ created: CREATED, task: TASK, preflight: { lanes: [] }, acceptance: { level: 'checked' } });
  assert.equal(withExtra.ok, false, JSON.stringify(withExtra.data));
  assert.deepEqual([withExtra.error.code, withExtra.error.phase], ['invalid_request', 'build']);
});

// The receiver is pi-subagents, installed beside pi rather than vendored here, so these drive its own validators when
// it is present. They are the check that matters: this package's own predicates said yes to both requests pi-subagents
// then refused — a `preflight` outside a workflow (PR #149 run 1) and an unknown acceptance evidence kind (#150).
const RECEIVER = path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
const receiverSkip = fs.existsSync(path.join(RECEIVER, 'src/extension/schemas.ts'))
  ? false
  : 'pi-subagents is not installed in this environment';

// Node refuses to strip types from a file under `node_modules`, and pi-subagents 0.69.0 ships TypeScript only, so the
// receiver's own sources are copied out once and driven there. The copy is read only; the symlinked `node_modules`
// resolves the receiver's own dependencies (`typebox`) exactly as pi resolves them.
const DRIVER = `import { SubagentParams } from './src/extension/schemas.ts';
import { normalizePublicSubagentExecution } from './src/extension/public-execution.ts';
import { validateAcceptanceInput } from './src/runs/shared/acceptance.ts';
import { Value } from 'typebox/value';
const request = JSON.parse(process.argv[2]);
const properties = SubagentParams.properties ?? {};
const normalized = normalizePublicSubagentExecution(request);
console.log(JSON.stringify({
  declared: Object.keys(properties),
  schema: { valid: Value.Check(SubagentParams, request), errors: [...Value.Errors(SubagentParams, request)].map((error) => error.message) },
  normalized: normalized.ok === false ? { ok: false, error: normalized.error } : { ok: true, params: normalized.params },
  acceptanceErrors: validateAcceptanceInput(request.acceptance),
}));
`;

let receiverRoot;
test.before(() => {
  if (receiverSkip) return;
  receiverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-152-receiver-'));
  fs.cpSync(path.join(RECEIVER, 'src'), path.join(receiverRoot, 'src'), { recursive: true });
  fs.symlinkSync(path.dirname(RECEIVER), path.join(receiverRoot, 'node_modules'));
  fs.writeFileSync(path.join(receiverRoot, 'driver.ts'), DRIVER);
});
test.after(() => { if (receiverRoot) fs.rmSync(receiverRoot, { recursive: true, force: true }); });

// What the installed pi-subagents says about one launch request, from its own schema and validators.
function askReceiver(request) {
  const driver = spawnSync(process.execPath, [path.join(receiverRoot, 'driver.ts'), JSON.stringify(request)], { encoding: 'utf8', timeout: 120000 });
  assert.equal(driver.status, 0, `the receiver's validators did not run: ${driver.error?.message ?? ''} ${driver.stderr}`);
  // A driver that exits 0 with anything but its one JSON line has not answered, and must not be read as agreement.
  try {
    return JSON.parse(driver.stdout);
  } catch (error) {
    assert.fail(`the receiver's answer was not readable (${error.message}): ${JSON.stringify(driver.stdout.slice(0, 400))}`);
  }
}

test('Issue #152 the receiver accepts the built request, and its schema declares every key', { skip: receiverSkip }, () => {
  const request = build({}).data.request;
  const answer = askReceiver(request);
  assert.ok(answer.declared.includes('agent') && answer.declared.includes('task') && answer.declared.includes('cwd'), 'the receiver schema was read, not guessed');
  for (const key of Object.keys(request)) assert.equal(answer.declared.includes(key), true, `the receiver declares ${key}`);
  assert.deepEqual([answer.schema.valid, answer.schema.errors], [true, []], 'the receiver schema validates the built request');
  assert.equal(answer.normalized.ok, true, `the receiver normalizes the built request without an error: ${answer.normalized.error}`);
  assert.deepEqual(answer.acceptanceErrors, [], 'the receiver validates the built acceptance without an error');
  // What the receiver makes of the request is what the builder emitted, plus the `output` default it injects itself.
  assert.deepEqual(answer.normalized.params, { ...request, output: true });
});

test('Issue #152 the receiver schema is run, not merely read', { skip: receiverSkip }, () => {
  // `SubagentParams` declares no `additionalProperties: false`, and `normalizePublicSubagentExecution` type-checks
  // only a few fields, so reading the declared names alone would accept a request with every value wrong
  // (ADV-152-RECEIVER-SCHEMA-NOT-DRIVEN). The schema itself is what refuses this one.
  const wrong = { ...build({}).data.request, context: 'bogus', async: 'yes', outputMode: 'nope', timeoutMs: '3600000', checkpointBeforeDeadlineMs: -5 };
  const answer = askReceiver(wrong);
  assert.equal(answer.normalized.ok, true, 'the normalizer alone accepts it, which is why the schema is run');
  assert.deepEqual(answer.acceptanceErrors, [], 'the acceptance validator alone accepts it too');
  assert.equal(answer.schema.valid, false, JSON.stringify(answer.schema));
  assert.equal(answer.schema.errors.length, 5, JSON.stringify(answer.schema.errors));
});

test('Issue #152 the receiver refuses what the parent composed by hand', { skip: receiverSkip }, () => {
  const request = build({}).data.request;
  // PR #149 run 1: `preflight` beside a one-child launch. The builder emits no such key; here the receiver says why.
  const withPreflight = askReceiver({ ...request, preflight: { lanes: [] } });
  assert.deepEqual([withPreflight.normalized.ok, withPreflight.normalized.error], [false, 'preflight requires workflowScript or workflowScriptPath.']);
  // Issue #150: an evidence kind pi-subagents does not know. The builder emits `acceptance: false`, which it accepts.
  const invented = askReceiver({ ...request, acceptance: { level: 'checked', evidence: ['tests-pass'] } });
  assert.equal(invented.acceptanceErrors.length, 1, JSON.stringify(invented.acceptanceErrors));
  assert.match(invented.acceptanceErrors[0], /^acceptance\.evidence\[0\] "tests-pass" is not a supported evidence kind\./);
  assert.deepEqual(askReceiver(request).acceptanceErrors, [], 'the built request is the control for both refusals');
});

test('Issue #152 the receiver refuses the built request with its required field removed', { skip: receiverSkip }, () => {
  // Of the fields the builder emits, `agent` is the one the receiver itself requires; the rest are optional there, so
  // the exact key set above is what fails when one of them is dropped. Measured, not assumed.
  const { agent, ...withoutAgent } = build({}).data.request;
  assert.equal(agent, 'tidd-autofix-worker');
  const answer = askReceiver(withoutAgent);
  assert.deepEqual([answer.normalized.ok, answer.normalized.error], [false, 'Structured single-child execution requires agent to be a non-empty string.']);
});

// The parent never calls the helper in process: it runs `node <installed>/helpers/cli.js` with a versioned JSON
// request (CL-D30, CL-D68). These drive that path, from a workspace `workspace_create` really made, so a builder
// reachable in process but not through the CLI — or a CLI input table widened to take `preflight` again — fails here
// (ADV-152-CLI-PATH-UNEXERCISED).
const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
function cli(operation, data, env = {}) {
  // The CLI exits nonzero for an `ok:false` envelope, which several cases below expect; the envelope is the answer.
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run.stdout, /^\{"version":1,/, `the CLI did not answer: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function withCreatedWorkspace(run) {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-152-repo-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-152-origin-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-152-parent-'));
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 152 Test']); git(root, ['config', 'user.email', 'issue152@example.invalid']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10));
    git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
    git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', '-q', 'origin', 'main']);
    const created = cli('workspace_create', { cwd: root, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) }, { TMPDIR: parent, TEMP: parent, TMP: parent });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    run(created.data);
  } finally {
    for (const dir of [parent, root, bare]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Issue #152 the packaged CLI builds the launch from a workspace the CLI created', () => {
  withCreatedWorkspace((created) => {
    const built = cli('build_writer_launch', { created, task: TASK });
    assert.equal(built.ok, true, JSON.stringify(built.error));
    // Producer output, not a fixture: the request the CLI returns is the one the builder emits for it.
    assert.deepEqual(built.data.request, helpers.buildWriterLaunch({ created, task: TASK }).data.request);
    assert.equal(built.data.request.cwd, created.path);
    assert.equal(built.data.request.agent, 'tidd-autofix-worker');
    assert.equal(built.data.request.acceptance, false);
    if (!receiverSkip) {
      const answer = askReceiver(built.data.request);
      assert.deepEqual([answer.schema.valid, answer.normalized.ok, answer.acceptanceErrors], [true, true, []], JSON.stringify(answer));
    }
  });
});

test('Issue #152 the packaged CLI takes the two inputs and no others', () => {
  withCreatedWorkspace((created) => {
    // `preflight` is the field that killed PR #149's first run; the CLI's own input table must refuse it, not only
    // the builder behind it.
    for (const [label, data] of [
      ['preflight', { created, task: TASK, preflight: { lanes: [] } }],
      ['an unknown field', { created, task: TASK, model: 'sol' }],
      ['no task', { created }],
      ['no workspace', { task: TASK }],
    ]) {
      const refused = cli('build_writer_launch', data);
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      // `cli` is the CLI's own input table refusing the request before the builder is reached.
      assert.deepEqual([refused.error.code, refused.error.phase], ['invalid_request', 'cli'], label);
    }
  });
});

test('Issue #152 the map states that the builder composes the writer launch', () => {
  const map = readText('skills/closed-loop-pr/references/autofix.md');
  assert.match(map, /\| Construct the writer launch from the workspace the run created \(CL-D81\) \| `build_writer_launch` \| `created` \(data of `workspace_create`\), `task` \|/);
});

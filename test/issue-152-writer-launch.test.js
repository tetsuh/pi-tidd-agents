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
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText } = require('./helpers');

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

test('Issue #152 the builder refuses what it cannot compose from', () => {
  for (const [label, data] of [
    ['no task', { task: undefined }],
    ['an empty task', { task: '  ' }],
    ['a task that is not a string', { task: 42 }],
    ['a clone fallback workspace', { created: { ...CREATED, kind: 'clone', cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable', receipt: undefined } }],
    ['no workspace', { created: undefined }],
  ]) {
    const refused = helpers.buildWriterLaunch({ created: CREATED, task: TASK, ...data });
    assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.error.phase, 'build', label);
  }
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
const RECEIVER = path.join(process.env.HOME || '', '.pi/agent/npm/node_modules/pi-subagents');
const receiverSkip = fs.existsSync(path.join(RECEIVER, 'src/extension/schemas.ts'))
  ? false
  : 'pi-subagents is not installed in this environment';

// Node refuses to strip types from a file under `node_modules`, and pi-subagents 0.69.0 ships TypeScript only, so the
// receiver's own sources are copied out once and driven there. The copy is read only; the symlinked `node_modules`
// resolves the receiver's own dependencies (`typebox`) exactly as pi resolves them.
const DRIVER = `import { SubagentParams } from './src/extension/schemas.ts';
import { normalizePublicSubagentExecution } from './src/extension/public-execution.ts';
import { validateAcceptanceInput } from './src/runs/shared/acceptance.ts';
const request = JSON.parse(process.argv[2]);
const properties = SubagentParams.properties ?? {};
const normalized = normalizePublicSubagentExecution(request);
console.log(JSON.stringify({
  declared: Object.keys(properties),
  normalized: normalized.ok === false ? { ok: false, error: normalized.error } : { ok: true },
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
  const driver = spawnSync(process.execPath, [path.join(receiverRoot, 'driver.ts'), JSON.stringify(request)], { encoding: 'utf8' });
  assert.equal(driver.status, 0, `the receiver's validators did not run: ${driver.stderr}`);
  return JSON.parse(driver.stdout);
}

test('Issue #152 the receiver accepts the built request, and its schema declares every key', { skip: receiverSkip }, () => {
  const request = build({}).data.request;
  const answer = askReceiver(request);
  assert.ok(answer.declared.includes('agent') && answer.declared.includes('task') && answer.declared.includes('cwd'), 'the receiver schema was read, not guessed');
  for (const key of Object.keys(request)) assert.equal(answer.declared.includes(key), true, `the receiver declares ${key}`);
  assert.deepEqual(answer.normalized, { ok: true }, 'the receiver normalizes the built request without an error');
  assert.deepEqual(answer.acceptanceErrors, [], 'the receiver validates the built acceptance without an error');
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

test('Issue #152 the map states that the builder composes the writer launch', () => {
  const map = readText('skills/closed-loop-pr/references/autofix.md');
  assert.match(map, /\| Construct the writer launch from the workspace the run created \(CL-D81\) \| `build_writer_launch` \| `created` \(data of `workspace_create`\), `task` \|/);
});

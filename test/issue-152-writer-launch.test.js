'use strict';

// Issue #152. The writer's launch request was the last one the parent composed by hand, and it went wrong twice in
// one day: PR #149 run 1 carried `preflight`, which pi-subagents accepts only beside a workflow script, and the run
// before it carried an `acceptance.evidence` list of kinds pi-subagents does not know (#150). `build_writer_launch`
// composes it instead, and the cases below check the built request against the receiver's own source, not only
// against this package's predicates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

// The receiver is pi-subagents, installed beside pi rather than vendored here, so these read its source when it is
// present. They are the check that matters: this package's own predicates said yes to both requests that pi-subagents
// then refused.
const RECEIVER = path.join(process.env.HOME || '', '.pi/agent/npm/node_modules/pi-subagents');
const receiverSkip = fs.existsSync(path.join(RECEIVER, 'src/extension/schemas.ts'))
  ? false
  : 'pi-subagents is not installed in this environment';

test('Issue #152 every key of the built request is one the receiver declares', { skip: receiverSkip }, () => {
  const schema = fs.readFileSync(path.join(RECEIVER, 'src/extension/schemas.ts'), 'utf8');
  // Property names of the launch input, as the receiver's schema declares them.
  const declared = new Set([...schema.matchAll(/^\t([A-Za-z][A-Za-z0-9]*): Type\./gm)].map((match) => match[1]));
  assert.ok(declared.has('agent') && declared.has('task') && declared.has('cwd'), 'the schema was parsed, not guessed');
  for (const key of Object.keys(build({}).data.request)) {
    assert.equal(declared.has(key), true, `the receiver declares ${key}`);
  }
});

test('Issue #152 the built request carries no key the receiver rejects outside a workflow', { skip: receiverSkip }, () => {
  const execution = fs.readFileSync(path.join(RECEIVER, 'src/extension/public-execution.ts'), 'utf8');
  // Keys the receiver refuses unless a workflow script is supplied, named by its own refusal messages.
  const workflowOnly = new Set([...execution.matchAll(/error: "([a-zA-Z]+) requires workflowScript or workflowScriptPath/g)].map((match) => match[1]));
  assert.ok(workflowOnly.has('preflight'), 'the refusals were parsed, not guessed');
  const request = build({}).data.request;
  for (const key of workflowOnly) assert.equal(Object.hasOwn(request, key), false, `${key} is workflow-only and must not be in a one-child request`);
});

test('Issue #152 the receiver accepts the acceptance value the builder emits', { skip: receiverSkip }, () => {
  const acceptance = fs.readFileSync(path.join(RECEIVER, 'src/runs/shared/acceptance.ts'), 'utf8');
  // `false` is the shorthand the receiver normalizes to no evidence policy; `true` is invalid there.
  assert.match(acceptance, /if \(input === false\) return errors;/, 'false is accepted by the receiver validator');
  assert.equal(build({}).data.request.acceptance, false);
});

test('Issue #152 the map states that the builder composes the writer launch', () => {
  const map = readText('skills/closed-loop-pr/references/autofix.md');
  assert.match(map, /\| Construct the writer launch from the workspace the run created \(CL-D81\) \| `build_writer_launch` \| `created` \(data of `workspace_create`\), `task` \|/);
});

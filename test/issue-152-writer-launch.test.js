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
const { readText, repoPath, sectionOf } = require('./helpers');

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

// The fields the declared shape reads of a clone fallback, not the whole `workspace_create` clone result, which also
// carries its inspection. What matters here is that `receipt` is absent rather than present and undefined: a spread of
// `receipt: undefined` leaves an own key behind, the declared shape then refuses the object one layer earlier, and the
// builder's clone rule never runs (ADV-152-CLONE-CASE-NOT-DISCRIMINATING).
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
  // A drive spelling is absolute on Windows and relative here, and the screen is the platform's own predicate, so the
  // expectation is read from it rather than written down (ADV152B-ABSOLUTE-SPELLING-NOT-PROCESS-CWD).
  for (const candidate of ['../../etc', 'workspace', 'C:/tmp/ws', '\\\\server\\share']) {
    const built = helpers.buildWriterLaunch({ created: { ...CREATED, path: candidate }, task: TASK });
    assert.equal(built.ok, path.isAbsolute(candidate), `${candidate}: ${JSON.stringify(built.error ?? built.data)}`);
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
const RECEIVER = path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
// The minimum this package contracts (CL-D25). The surfaces these cases drive arrived after 0.36.0, and CL-D80's
// `checkpointBeforeDeadlineMs` arrived in 0.68.0, so an install below the minimum is a refusal, never a skip: only a
// missing package skips (ADV-158-RECEIVER-MINIMUM-DRIFT, owner decision on PR #158).
const RECEIVER_MINIMUM = '0.69.0';
const RECEIVER_SOURCES = ['src/extension/schemas.ts', 'src/extension/public-execution.ts', 'src/runs/shared/acceptance.ts'];
const receiverSkip = fs.existsSync(path.join(RECEIVER, 'package.json'))
  ? false
  : 'pi-subagents is not installed in this environment';
// Only an absent package skips (CL-D25, CL-D81). An installed receiver missing a source the run drives fails, and
// fails naming the minimum: the copy that would throw a bare ENOENT is not attempted, and each case that drives the
// receiver says which source is missing (ADV-158-INSTALLED-RECEIVER-SOURCE-SKIPS, ADV158D-BEFORE-HOOK-UNGUARDED).
const receiverSources = () => RECEIVER_SOURCES.every((source) => fs.existsSync(path.join(RECEIVER, source)));
function requireReceiverSources() {
  const installed = JSON.parse(fs.readFileSync(path.join(RECEIVER, 'package.json'), 'utf8')).version;
  for (const source of RECEIVER_SOURCES) {
    assert.equal(fs.existsSync(path.join(RECEIVER, source)), true, `pi-subagents ${installed} carries no ${source}; the contracted minimum is ${RECEIVER_MINIMUM} (CL-D25)`);
  }
}

// `0.69.0-rc1` is below `0.69.0`, and a version this cannot read is below everything: the comparison is fail-closed
// in both directions rather than producing NaN (ADV158D-PRERELEASE-NAN).
function belowMinimum(version) {
  // SemVer 2.0.0: numeric identifiers without leading zeros, an optional dot-separated prerelease, and optional build
  // metadata, which carries no precedence at all. Anything else is unreadable, and unreadable is below everything.
  const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
  const NUMBER = '(?:0|[1-9]\\d*)';
  const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const parsed = SEMVER.exec(typeof version === 'string' ? version : '');
  if (!parsed) return true;
  const [major, minor, patch] = parsed.slice(1, 4).map(Number);
  const [lowMajor, lowMinor, lowPatch] = RECEIVER_MINIMUM.split('.').map(Number);
  if (major !== lowMajor) return major < lowMajor;
  if (minor !== lowMinor) return minor < lowMinor;
  if (patch !== lowPatch) return patch < lowPatch;
  return parsed[4] !== undefined; // a prerelease of the minimum itself
}

test('Issue #152 an installed receiver below the contracted minimum is a failure, not a skip', { skip: receiverSkip }, () => {
  const installed = JSON.parse(fs.readFileSync(path.join(RECEIVER, 'package.json'), 'utf8')).version;
  assert.equal(belowMinimum(installed), false, `pi-subagents ${JSON.stringify(installed)} is below the contracted minimum ${RECEIVER_MINIMUM} (CL-D25)`);
  for (const source of RECEIVER_SOURCES) {
    assert.equal(fs.existsSync(path.join(RECEIVER, source)), true, `pi-subagents ${installed} carries no ${source}; the contracted minimum is ${RECEIVER_MINIMUM} (CL-D25)`);
  }
});

// The comparison itself, in a case of its own: it needs no receiver, and inside the case above it was skipped wherever
// pi-subagents is not installed — which is every CI run (ADV158E-TABLE-SKIPPED-IN-CI).
test('Issue #152 the version comparison is SemVer precedence, and fail-closed', () => {
  for (const [version, below] of [
    ['0.36.0', true], ['0.7.0', true], ['0.69.0', false], ['0.70.0', false], ['0.690.0', false], ['1.0.0', false], ['0.69.1', false],
    // A prerelease is below its own release; a prerelease of a higher version is not below the minimum.
    ['0.69.0-rc1', true], ['0.69.0-rc.1', true], ['0.69.0-0', true], ['0.69.1-rc1', false],
    // Build metadata carries no precedence at all, so it neither raises nor lowers a version
    // (ADV-158-SEMVER-BUILD-METADATA).
    ['0.69.0+build.1', false], ['0.70.0+build.1', false], ['0.69.0+build-1', false], ['0.69.0-rc.1+build.1', true], ['0.36.0+build.1', true],
    // Not SemVer, so not readable, so below everything: the refusal side, which a widened pattern would quietly open
    // (ADV158E-PRERELEASE-CLASS-UNPINNED, ADV158E-BUILD-CLASS-UNPINNED, ADV158E-LEADING-ZERO-ACCEPTED).
    [undefined, true], ['0.69', true], ['0.69.0+', true], ['0.69.0-', true], ['0.69.0+a+b', true], ['0.69.1-rc_1', true],
    ['v0.69.0', true], [' 0.69.0', true], ['0.69.0\n', true], ['00.69.0', true], ['0.069.0', true], ['0.69.0+.', true],
    // A lone hyphen is a build identifier SemVer allows, so this one is readable and not below.
    ['0.69.0+-', false],
  ]) {
    assert.equal(belowMinimum(version), below, `${JSON.stringify(version)} against ${RECEIVER_MINIMUM}`);
  }
});

test('Issue #152 the contracted minimum is the one the package documents', () => {
  // One minimum, stated in three places: the record, the README, and the regression that drives the receiver.
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D25 — Validated `pi-subagents` minimum, and what a normal commit is');
  assert.ok(record, 'CL-D25 must exist');
  // Compared as text, not as a pattern built from it: a version is a literal here, and a regex assembled from data is
  // the incomplete-sanitization shape CodeQL refuses (js/incomplete-sanitization, PR #158).
  assert.ok(record.includes(`The validated minimum is \`${RECEIVER_MINIMUM}\``), `CL-D25 must state ${RECEIVER_MINIMUM}`);
  assert.match(record, /`checkpointBeforeDeadlineMs` arrived in `0\.68\.0`/, 'the record states why the old minimum could not stand');
  const readme = readText('README.md');
  assert.ok(readme.includes(`**${RECEIVER_MINIMUM} or newer**`), `the README must require ${RECEIVER_MINIMUM} or newer`);
  // Not only the superseded minimum: any version the README names is a claim about what this package supports, and a
  // version below the minimum is the same drift the minimum was raised for (ADV158D-README-OLDER-FLOORS).
  for (const [version] of readText('README.md').matchAll(/\b(\d+\.\d+\.\d+)\b/g)) {
    assert.equal(belowMinimum(version), false, `the README names ${version}, below the contracted minimum ${RECEIVER_MINIMUM}`);
  }
});

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
  if (receiverSkip || !receiverSources()) return;
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
  requireReceiverSources();
  const request = build({}).data.request;
  const answer = askReceiver(request);
  // The declared names come from the receiver's schema object; the validation below runs that schema over the request.
  assert.ok(answer.declared.includes('agent') && answer.declared.includes('task') && answer.declared.includes('cwd'), 'the receiver schema was loaded, not guessed');
  for (const key of Object.keys(request)) assert.equal(answer.declared.includes(key), true, `the receiver declares ${key}`);
  assert.deepEqual([answer.schema.valid, answer.schema.errors], [true, []], 'the receiver schema validates the built request');
  assert.equal(answer.normalized.ok, true, `the receiver normalizes the built request without an error: ${answer.normalized.error}`);
  assert.deepEqual(answer.acceptanceErrors, [], 'the receiver validates the built acceptance without an error');
  // What the receiver makes of the request is what the builder emitted, plus the `output` default it injects itself.
  assert.deepEqual(answer.normalized.params, { ...request, output: true });
});

test('Issue #152 the receiver schema is run, not merely read', { skip: receiverSkip }, () => {
  requireReceiverSources();
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
  requireReceiverSources();
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
  requireReceiverSources();
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
    if (!receiverSkip && receiverSources()) {
      const answer = askReceiver(built.data.request);
      assert.deepEqual([answer.schema.valid, answer.normalized.ok, answer.acceptanceErrors], [true, true, []], JSON.stringify(answer));
    }
  });
});

test('Issue #152 the packaged CLI takes the two inputs and no others', () => {
  // These are refused by the CLI's own input table before `created` is read, so the fixture workspace is the frozen
  // one: a repository would prove nothing the table does not (ADV152B-CLI-TABLE-FIXTURE-UNUSED). `preflight` is the
  // field that killed PR #149's first run, and it must be refused here as well as in the builder behind it.
  for (const [label, data] of [
    ['preflight', { created: CREATED, task: TASK, preflight: { lanes: [] } }],
    ['an unknown field', { created: CREATED, task: TASK, model: 'sol' }],
    ['no task', { created: CREATED }],
    ['no workspace', { task: TASK }],
  ]) {
    const refused = cli('build_writer_launch', data);
    assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
    // `cli` is the CLI's own input table refusing the request before the builder is reached.
    assert.deepEqual([refused.error.code, refused.error.phase], ['invalid_request', 'cli'], label);
  }
});

// M2 of the second adversarial pass: CL-D81 states the emitted fields, and nothing compared that statement with the
// builder. Rewriting every value in the record left the suite green. The record is now read and compared.
test('Issue #152 the record states the fields the builder emits', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D81 — The exact-autofix writer launch is composed by a packaged builder');
  assert.ok(record, 'CL-D81 must exist');
  const choice = record.split(String.fromCharCode(10)).find((line) => line.startsWith('*Owner choice:*'));
  // A pair the pattern misses is not read as agreement: the key drops out, and the completeness assertion below
  // fails. A value that is not JSON is compared as the text it is, rather than thrown out of the test.
  const read = (value) => { try { return JSON.parse(value); } catch { return value; } };
  const pairs = [...choice.matchAll(/`([A-Za-z]+): ("?[A-Za-z0-9_-]+"?)`/g)].map((match) => [match[1], read(match[2])]);
  const stated = new Map(pairs);
  assert.equal(stated.size, pairs.length, 'the record states each field once');
  const request = build({}).data.request;
  for (const [field, value] of stated) assert.deepEqual(request[field], value, `the record states ${field}: ${JSON.stringify(value)}`);
  // The statement is complete as well as true: every emitted field except the two the parent supplies is stated.
  assert.deepEqual([...stated.keys()].sort(), Object.keys(request).filter((key) => key !== 'task' && key !== 'cwd').sort());
});

// The behaviour CL-D25 and CL-D81 state, measured rather than asserted about this machine: this file is run again
// against a fake installed receiver — a manifest below the minimum with no sources — and must fail naming the
// minimum, skipping nothing that drives the receiver (ADV-158-INSTALLED-RECEIVER-SOURCE-SKIPS). The child is told it
// is the fixture, so it does not run this case again.
const FIXTURE = 'ISSUE_152_RECEIVER_FIXTURE';
test('Issue #152 an installed receiver missing its sources fails naming the minimum, and skips nothing', { skip: process.env[FIXTURE] ? 'this run is the fixture child' : false }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-152-fakehome-'));
  try {
    const fake = path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: '0.36.0' }));
    // HOME and USERPROFILE together, since `os.homedir()` reads the one its platform uses. `NODE_TEST_CONTEXT` is
    // dropped: inherited, it tells the child it is already inside a test run and its report never arrives.
    const env = { ...process.env, HOME: home, USERPROFILE: home, [FIXTURE]: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', repoPath('test/issue-152-writer-launch.test.js')], {
      encoding: 'utf8', timeout: 300000, cwd: repoPath('.'), env,
    });
    assert.notEqual(child.status, 0, `the fixture run must fail: ${child.stdout.slice(-400)}`);
    assert.match(child.stdout, /is below the contracted minimum 0\.69\.0 \(CL-D25\)/, 'the version is reported against the minimum');
    assert.match(child.stdout, /carries no src\/extension\/schemas\.ts; the contracted minimum is 0\.69\.0 \(CL-D25\)/, 'each receiver case names the missing source');
    // Nothing skipped but this case, which the child was told to leave alone.
    const skipped = Number(/^# skipped (\d+)$/m.exec(child.stdout)?.[1]);
    assert.equal(skipped, 1, `only the fixture case may be skipped: ${child.stdout.slice(-400)}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Issue #152 the map states that the builder composes the writer launch', () => {
  const map = readText('skills/closed-loop-pr/references/autofix.md');
  assert.match(map, /\| Construct the writer launch from the workspace the run created \(CL-D81\) \| `build_writer_launch` \| `created` \(data of `workspace_create`\), `task` \|/);
});

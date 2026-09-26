'use strict';

// Issue #111 (CL-D68). The two gate documents the parent still assembled by hand, packaged as a
// read-only reader and a read-only composer. `readGateResult` opens the runner's own status record
// for a run id and returns the envelope at that record's structured output path (CL-D58): the parent
// never chooses a path. `buildGateLaunch` composes the launch request from the built expectation and
// the installed package's own payload blocks (CL-D2, CL-D29): the schema is the builder's byte for
// byte, the blocks are copied verbatim with their digests recorded, and the request has no output
// field and no free-text envelope instruction. The helper-trust probe lives in paths.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createResult, createError } = require('./protocol');
const { SCHEMA, ROOT_GATES, expectedState, validateGateResult } = require('./gate-result');
const { inputShapeProblem } = require('./composition');
const { VOLATILE_FIELDS, volatileRequired, volatileEmptiness, nestedProblem, citedRecords } = require('./envelope');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_PATH = path.join(__dirname, 'cli.js');
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The runner's in-progress step states (pi-subagents 0.67.0): before a step has ended there is nothing to read.
const STEP_IN_PROGRESS = Object.freeze(['pending', 'running']), RUN_IN_PROGRESS = Object.freeze(['queued', 'running']);
// One table, pinned against the vocabulary source by test/issue-111-gate-read-launch.test.js.
const ROLE_BY_GATE = Object.freeze({ adversarial: 'tidd-adversarial-reviewer', 'decision-drift': 'tidd-drift-reviewer', safety: 'tidd-safety-reviewer', convergence: 'tidd-convergence-reviewer' });
const EVERY_GATE = Object.freeze({ file: 'skills/closed-loop-shared/references/gate-contract.md', heading: '#### Every-gate invariant payload block (CL-D2)' });
const SOL_ONLY = Object.freeze({ file: 'skills/closed-loop-shared/references/gate-contract.md', heading: '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)' });
const ROLE_BLOCKS = Object.freeze({
  issue: Object.freeze({ file: 'skills/closed-loop-issue/SKILL.md', heading: '### Issue gate role-authority blocks (CL-D2)', label: 'Issue' }),
  pr: Object.freeze({ file: 'skills/closed-loop-pr/SKILL.md', heading: '### PR gate role-authority blocks (CL-D2)', label: 'PR' }),
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function readUtf8(file) { return fs.readFileSync(file, 'utf8'); }

// The runner's async-runs root, derived as pi-subagents 0.67.0 derives it (shared/types.ts): a configured
// PI_SUBAGENTS_TEMP_ROOT, else the OS temp directory scoped by uid, then user name, then home directory, then
// shared (CONV-123-RUN-ROOT-DERIVATION). Fixtures inject the host; the CLI reads the real one.
function scopeSegment(value) { const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); return clean || 'unknown'; }
function tempScopeId(host) {
  if (typeof host.getuid === 'function') return `uid-${host.getuid()}`;
  for (const key of ['USERNAME', 'USER', 'LOGNAME']) if (host.env[key]) return `user-${scopeSegment(host.env[key])}`;
  try { const name = host.userInfo?.().username; if (name) return `user-${scopeSegment(name)}`; } catch { /* no user database */ }
  const home = host.env.USERPROFILE ?? host.env.HOME;
  if (home) return `home-${scopeSegment(home)}`;
  try { const fallback = host.homedir?.(); if (fallback) return `home-${scopeSegment(fallback)}`; } catch { /* no home */ }
  return 'shared';
}
function runsRoot(host = { env: process.env, getuid: process.getuid?.bind(process), userInfo: os.userInfo, homedir: os.homedir, tmpdir: os.tmpdir() }) {
  const configured = host.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return path.join(configured ? path.resolve(configured) : path.join(host.tmpdir, `pi-subagents-${tempScopeId(host)}`), 'async-subagent-runs');
}

// The first JSON path at which two values differ, or null when they are equal (#184).
function firstDifference(actual, expected, at) {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return at;
    for (let i = 0; i < expected.length; i += 1) { const d = firstDifference(actual[i], expected[i], `${at}/${i}`); if (d !== null) return d; }
    return null;
  }
  if (plain(expected) || plain(actual)) {
    if (!plain(actual) || !plain(expected)) return at;
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return `${at}/${key}`;
      const d = firstDifference(actual[key], expected[key], `${at}/${key}`); if (d !== null) return d;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : at;
}
function readGateResult(data) {
  const operation = 'gate_result_read';
  try {
    if (!plain(data) || !text(data.runId) || !RUN_ID.test(data.runId)) fail('invalid_request', 'runId must be the runner run id (a UUID)');
    // The packaged request names a run, never a place to read it from: the CLI schema carries no
    // `runsRoot`, so a caller cannot point the read at a forged root (SAFETY-123-RUNSROOT-OVERRIDE).
    // The override below is reachable only by a direct in-process call, which is the fixture's.
    if (Object.hasOwn(data, 'runsRoot') && !text(data.runsRoot)) fail('invalid_request', 'runsRoot must be a nonempty string when given');
    const statusPath = path.join(data.runsRoot || runsRoot(), data.runId, 'status.json');
    let statusText;
    try { statusText = readUtf8(statusPath); } catch (error) { fail('status_absent', `runner status record is not readable: ${error.message}`, { statusPath }); }
    let status;
    try { status = JSON.parse(statusText); } catch (error) { fail('status_unparsable', `runner status record is not JSON: ${error.message}`, { statusPath }); }
    if (!plain(status) || status.runId !== data.runId) fail('run_mismatch', 'runner status record names a different run', { statusPath, recordedRunId: plain(status) ? status.runId ?? null : null });
    // The run state is reported, never decides: a validated envelope at the designated path is the verdict
    // whatever the runner's status says (CL-D58); the selected step's own completion is checked below.
    // The last recorded step is the selected step, whatever it is: an earlier step's output is never read
    // in its place, and a malformed trailing record is not skipped over to reach one
    // (CONV-123-STALE-STEP-READ, CONV-123-LAST-STEP-SHAPE).
    const steps = Array.isArray(status.steps) ? status.steps : [];
    const step = steps.length === 0 ? null : steps[steps.length - 1];
    // A step the runner still records as in progress, in a run it still records as in progress, is not a result and
    // not a failure: a workflow-layer completion notice is a courier (CL-D58), and the parent waits for the runner's
    // own completion before reading again (CL-D68 amendment, PR #124). A run already recorded as terminal is never in
    // progress, whatever its last step says, because nothing more will be written to it.
    if (plain(step) && STEP_IN_PROGRESS.includes(step.status) && RUN_IN_PROGRESS.includes(status.state)) fail('run_in_progress', `the runner still records the selected step as ${step.status}; wait for its completion and read again`, { statusPath, stepStatus: step.status });
    if (!plain(step) || !text(step.structuredOutputPath)) fail('designated_output_unrecorded', 'the selected step of the runner status record carries no structuredOutputPath', { statusPath });
    const structuredOutputPath = step.structuredOutputPath;
    // #184, CL-D90: the schema the child ran with is the one the runner recorded for the step. If it is not the packaged
    // schema, the launch diverged (a parent-added outputSchema overrides the agent definition's), whatever the step's
    // status says. It is read only from inside the run directory, by filesystem identity, as the output is below.
    // The check fails closed: a step that records no schema, or one that cannot be read, ran without the packaged
    // schema as far as anyone can show (CONV-187-SCHEMA-READ-FAILOPEN), e.g. under a replacement gate definition that
    // declares none (CONV-187-CUSTOM-GATE-SCHEMA).
    // An incomplete step (a timeout or a stop records no schema) reports as incomplete below unless it demonstrably ran
    // with another schema; a complete step must show the packaged one.
    const complete = step.status === 'complete';
    const schemaProblem = (code, message, details) => { if (complete) fail(code, message, details); };
    const childSchemaPath = step.structuredOutputSchemaPath;
    let childSchema;
    if (!text(childSchemaPath)) schemaProblem('designated_schema_unrecorded', 'the selected step records no structuredOutputSchemaPath; the gate did not run with the packaged schema', { statusPath });
    else {
      let canonicalSchema;
      try { canonicalSchema = fs.realpathSync.native(childSchemaPath); } catch { canonicalSchema = null; }
      if (canonicalSchema === null) schemaProblem('designated_schema_unreadable', 'the recorded output schema is not readable', { statusPath, childSchemaPath });
      else {
        const within = path.relative(fs.realpathSync.native(path.dirname(statusPath)), canonicalSchema);
        if (!within || within.startsWith('..') || path.isAbsolute(within)) fail('designated_output_outside_run', 'the recorded output schema is outside the run directory', { statusPath, childSchemaPath, canonicalSchema });
        try { childSchema = JSON.parse(readUtf8(canonicalSchema)); } catch { schemaProblem('designated_schema_unreadable', 'the recorded output schema is not JSON', { statusPath, childSchemaPath }); }
      }
    }
    const differs = childSchema === undefined ? null : firstDifference(childSchema, SCHEMA, '');
    if (differs !== null) fail('schema_transcription_mismatch', `the child ran with an outputSchema other than the packaged one, first differing at ${differs || '/'}; the launch request, not the reviewed change, is at fault`, { statusPath, childSchemaPath, path: differs });
    // A completed run whose selected step failed, is still running, or carries no status is not a result,
    // whatever sits at its path (CONV-123-INCOMPLETE-STEP-READ).
    if (step.status !== 'complete') fail('step_incomplete', `selected step status is ${JSON.stringify(step.status ?? null)}`, { statusPath, structuredOutputPath, stepStatus: step.status ?? null });
    // The designated output belongs to the run it is read for, by filesystem identity rather than by
    // spelling: a link inside the run directory pointing outside it is outside it
    // (CONV-123-DESIGNATED-OUTPUT-SYMLINK).
    let canonicalOutput, canonicalRun;
    try { canonicalOutput = fs.realpathSync.native(structuredOutputPath); canonicalRun = fs.realpathSync.native(path.dirname(statusPath)); }
    catch (error) { fail('designated_output_absent', `designated output is not readable: ${error.message}`, { statusPath, structuredOutputPath }); }
    const inside = path.relative(canonicalRun, canonicalOutput);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) fail('designated_output_outside_run', 'the designated output is outside the run directory', { statusPath, structuredOutputPath, canonicalOutput });
    let outputText;
    try { outputText = readUtf8(canonicalOutput); } catch (error) { fail('designated_output_absent', `designated output is not readable: ${error.message}`, { statusPath, structuredOutputPath }); }
    const bytes = Buffer.byteLength(outputText);
    if (outputText.trim().length === 0) fail('designated_output_empty', `designated output holds ${bytes} bytes and no content`, { statusPath, structuredOutputPath, bytes });
    let envelope;
    try { envelope = JSON.parse(outputText); } catch (error) { fail('designated_output_unparsable', `designated output is not JSON: ${error.message}`, { statusPath, structuredOutputPath, bytes }); }
    if (!plain(envelope)) fail('designated_output_unparsable', 'designated output is not a JSON object', { statusPath, structuredOutputPath, bytes });
    // The composition CL-D73 packages: given the expectation file `build_gate_launch` already verified, the read
    // returns the envelope validated by the same code `gate_result_validate` runs, so the parent carries no
    // document from one operation into the next (#125 run 4 sent the builder's inputs in place of `expected`).
    const reported = { statusPath, structuredOutputPath, bytes, state: status.state ?? null, stepStatus: step.status ?? null, envelope };
    if (!Object.hasOwn(data, 'expectationPath')) return createResult(operation, reported);
    if (!text(data.expectationPath)) fail('invalid_request', 'expectationPath must be a nonempty string when given');
    let expectationText;
    try { expectationText = readUtf8(data.expectationPath); } catch (error) { fail('expectation_file_absent', `expectation file is not readable: ${error.message}`, { expectationPath: data.expectationPath }); }
    let expected;
    try { expected = JSON.parse(expectationText); } catch (error) { fail('expectation_file_mismatch', `expectation file is not JSON: ${error.message}`, { expectationPath: data.expectationPath }); }
    const details = { expectationPath: data.expectationPath, statusPath, structuredOutputPath };
    const validated = validateGateResult(envelope, expected);
    // The validator judges the expectation with the envelope's own version, so this read refuses nothing the
    // two-step path accepts (CL-D60). Its `invalid_request` is always about the expectation and never about the
    // envelope, and here that expectation came from a file: that one code is reported as the file's fault. The
    // expectation's own schema failures keep the validator's codes, named by their `expected.` path, and every
    // refusal carries the file it read.
    if (!validated.ok) {
      const code = validated.error.code === 'invalid_request' ? 'expectation_file_mismatch' : validated.error.code;
      return { ...validated, operation, error: { ...validated.error, code, details } };
    }
    return createResult(operation, { ...reported, ...validated.data });
  } catch (error) {
    return createError(operation, error.code || 'read_failed', error.message, operation, error.details);
  }
}

// The section under `heading` up to the next heading of the same or shallower depth, verbatim.
function section(content, heading) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) { const match = lines[end].match(/^(#+)\s/); if (match && match[1].length <= depth) break; end += 1; }
  return lines.slice(start, end).join('\n');
}
function packageBlock(source) {
  const file = path.join(PACKAGE_ROOT, source.file);
  let content;
  try { content = readUtf8(file); } catch (error) { fail('block_absent', `payload block file is not readable: ${error.message}`, { file }); }
  const found = section(content, source.heading);
  if (found === null) fail('block_absent', `payload block heading not found: ${source.heading}`, { file, heading: source.heading });
  return { file: source.file, heading: source.heading, sha256: sha256(found), bytes: Buffer.byteLength(found), content: found };
}
function roleBlockLine(source, nickname) {
  const block = packageBlock(source);
  const prefix = `- \`${source.label} ${nickname} role-authority block\`: \``;
  const line = block.content.split('\n').find((candidate) => candidate.startsWith(prefix) && candidate.endsWith('`'));
  if (!line) fail('block_absent', `role-authority block line not found: ${source.label} ${nickname}`, { file: source.file, heading: source.heading });
  // The selected block is the source line itself, copied verbatim (CL-D2; CONV-123-ROLE-BLOCK-VERBATIM).
  return { block, line };
}

function buildGateLaunch(data) {
  const operation = 'build_gate_launch';
  try {
    if (!plain(data)) fail('invalid_request', 'request data must be a plain object');
    // A field this composer does not know is a request it cannot honour, and a misspelt `created` would silently
    // leave the child in the parent's cwd (CL-D82). The CLI refuses one too; this is the in-process boundary.
    for (const key of Object.keys(data)) {
      if (!GATE_LAUNCH_INPUTS.includes(key)) fail('invalid_request', `unknown request field: ${key}`);
    }
    // The boundary's own predicate table judges the cross-operation field first (CL-D44, CL-D68).
    const shapeProblem = inputShapeProblem('build_gate_launch', data);
    if (shapeProblem !== null) fail('input_shape_mismatch', shapeProblem);
    if (!text(data.expectationPath)) fail('invalid_request', 'expectationPath must be a nonempty string');
    // The path is interpolated into the task, so a delimiter in it would append prose to the payload
    // (ADV-123-EXPECTATION-PATH-INJECTION).
    if (/[\r\n`]/.test(data.expectationPath)) fail('invalid_request', 'expectationPath must not contain a line break or a backtick');
    // The child validates its draft against this file (CL-D65). While it inherited the parent's cwd a relative path
    // resolved; sent to the workspace under CL-D82 it would resolve inside the worked tree, or nowhere.
    if (Object.hasOwn(data, 'created') && !path.isAbsolute(data.expectationPath)) fail('invalid_request', 'expectationPath must be absolute when the child runs in the workspace');
    if (!plain(data.volatile)) fail('invalid_request', 'volatile must be a plain object');
    for (const key of Object.keys(data.volatile)) if (!Object.hasOwn(VOLATILE_FIELDS, key)) fail('volatile_unknown_field', `volatile carries an unknown field: ${key}`, { field: key, allowed: Object.keys(VOLATILE_FIELDS) });
    for (const [key, kind] of Object.entries(VOLATILE_FIELDS)) {
      if (!Object.hasOwn(data.volatile, key)) continue;
      const value = data.volatile[key];
      const okShape = kind === 'string' ? typeof value === 'string' : kind === 'array' ? Array.isArray(value) : plain(value);
      if (!okShape) fail('invalid_request', `volatile field ${key} must be ${kind === 'array' ? 'an array' : kind === 'object' ? 'a plain object' : 'a string'}`);
    }
    const expected = data.expectation.expected;
    expectedState(expected);
    // A gate outside its root cannot validate later; refuse it before any file is read (CONV-123-ROOT-GATE-LAUNCH).
    if (!ROOT_GATES[expected.workflow].includes(expected.correlation.gate)) fail('gate_outside_root', `gate ${expected.correlation.gate} is not a ${expected.workflow} gate`);
    for (const key of volatileRequired(expected.workflow, expected.correlation.gate)) {
      if (!Object.hasOwn(data.volatile, key)) fail('invalid_request', `volatile lacks required field: ${key}`);
    }
    const emptiness = volatileEmptiness(expected, data.volatile);
    if (emptiness !== null) fail('invalid_request', emptiness);
    const nested = nestedProblem(data.volatile, expected.correlation, expected.workflow);
    if (nested !== null) fail(nested.code, nested.message);
    const cited = citedRecords(data.volatile);
    if (cited.problem) fail(cited.problem.code, cited.problem.message);
    let fileText;
    try { fileText = readUtf8(data.expectationPath); } catch (error) { fail('expectation_file_absent', `expectation file is not readable: ${error.message}`, { expectationPath: data.expectationPath }); }
    let fileExpected;
    try { fileExpected = JSON.parse(fileText); } catch (error) { fail('expectation_file_mismatch', `expectation file is not JSON: ${error.message}`, { expectationPath: data.expectationPath }); }
    if (JSON.stringify(fileExpected) !== JSON.stringify(expected)) fail('expectation_file_mismatch', 'expectation file does not equal the built expectation', { expectationPath: data.expectationPath });
    const gate = expected.correlation.gate;
    const agent = ROLE_BY_GATE[gate];
    if (!agent) fail('invalid_request', `no role owns gate ${JSON.stringify(gate)}`);
    const blocks = [packageBlock(EVERY_GATE)];
    const parts = [blocks[0].content];
    if (gate === 'adversarial') { const sol = packageBlock(SOL_ONLY); blocks.push(sol); parts.push(sol.content); }
    if (gate !== 'convergence') {
      const role = roleBlockLine(ROLE_BLOCKS[expected.workflow], gate === 'adversarial' ? 'Sol' : 'Terra');
      blocks.push(role.block); parts.push(role.line);
    }
    // The envelope carries the gate correlation as the expectation states it, derived here (CL-D47's rule).
    parts.push(`## Volatile envelope\n\n\`\`\`json\n${JSON.stringify({ ...data.volatile, ...cited.lists, correlation: expected.correlation }, null, 2)}\n\`\`\``);
    // The expectation rides along as data for the child's self-validation (CL-D65); its identities stay here (CL-D69).
    parts.push(`## Expectation (data; the identities stay here and are never copied)\n\n\`\`\`json\n${JSON.stringify(expected, null, 2)}\n\`\`\``);
    // The evidence records the envelope carries: source and kind from the expectation, no identity, and readCompletely
    // as the child's attestation after reading (CL-D69: three runs lost to one retyped character).
    parts.push(`## Evidence records (copy each; set readCompletely true after reading)\n\n\`\`\`json\n${JSON.stringify(expected.requiredEvidence.map(({ source, kind }) => ({ source, kind, readCompletely: false })), null, 2)}\n\`\`\``);
    parts.push(`Expectation file: ${data.expectationPath}\nPackaged validator: node ${CLI_PATH} (operation gate_result_validate, CL-D65)`);
    // #184, CL-D90: the schema is the gate role's own `outputSchema` (its agent definition), so the request carries none and the
    // parent has nothing to re-type; a parent-typed schema displaced every `required` array into `properties`.
    const request = { agent, task: `${parts.join('\n\n')}\n`, context: 'fresh', async: true, outputMode: 'inline', acceptance: false };
    // CL-D82: an exact-autofix gate reads the tree the run works in, so the launch names it; review-only has no
    // workspace and its child inherits the operator checkout, which is the tree it reviews. The envelope already
    // states which mode this is, so the two are related here rather than left to the parent's memory: an autofix
    // launch without the workspace is the very hazard this record closed (ADV159B-MODE-AND-WORKSPACE-UNRELATED).
    const autofix = data.volatile.target.mode === 'autofix';
    if (autofix && !Object.hasOwn(data, 'created')) fail('invalid_request', 'an autofix gate runs in the run-owned workspace; pass the workspace_create data as created');
    if (!autofix && Object.hasOwn(data, 'created')) fail('invalid_request', 'a review-only gate reviews the operator checkout; it takes no workspace');
    if (Object.hasOwn(data, 'created')) request.cwd = gateWorkspaceCwd(data.created);
    return createResult(operation, { request, blocks: blocks.map(({ file, heading, sha256: digest, bytes }) => ({ file, heading, sha256: digest, bytes })), packageRoot: PACKAGE_ROOT });
  } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build', error.details);
  }
}

// The workspace path a launch may carry as its child's cwd: producer output by the declared shape, and a spelling
// a process can be given (CL-D81's screen, applied to the gate launch under CL-D82).
function gateWorkspaceCwd(created) {
  if (created.kind !== 'linked') fail('invalid_request', 'a gate child runs in the run-owned linked workspace; a clone fallback is retained and never entered');
  const cwd = created.path;
  if (cwd.includes(String.fromCharCode(0)) || !cwd.isWellFormed()) fail('invalid_request', 'the workspace path carries a NUL byte or a lone surrogate');
  if (!path.isAbsolute(cwd)) fail('invalid_request', 'the workspace path must be absolute; a relative cwd resolves against the receiver, not the run');
  return cwd;
}

const GATE_LAUNCH_INPUTS = Object.freeze(['expectation', 'expectationPath', 'volatile', 'created']);

// CL-D81 (Issue #152): the writer launch, composed here rather than by the parent. Two runs of PR #149 died on a
// field the parent typed: `preflight`, which pi-subagents takes only beside a workflow script, and an
// `acceptance.evidence` list of kinds it does not know (#150). The parent states the task; every other field is this.
const WRITER_LAUNCH = Object.freeze({ agent: 'tidd-autofix-worker', context: 'fork', async: true, outputMode: 'inline',
  // CL-D80's settings, now emitted: no receiver-side grading of the batch this package's guards verify, a bound well
  // above a batch and below an unbounded run, and a checkpoint request that stops it between guarded steps.
  acceptance: false, timeoutMs: 3600000, checkpointBeforeDeadlineMs: 600000 });
const WRITER_INPUTS = Object.freeze(['created', 'task']);
function buildWriterLaunch(data) {
  const operation = 'build_writer_launch';
  try {
    if (!plain(data)) fail('invalid_request', 'request data must be a plain object');
    for (const key of Object.keys(data)) {
      if (!WRITER_INPUTS.includes(key)) fail('invalid_request', `unknown request field: ${key}`);
    }
    const shapeProblem = inputShapeProblem('build_writer_launch', data);
    if (shapeProblem !== null) fail('input_shape_mismatch', shapeProblem);
    if (data.created.kind !== 'linked') fail('invalid_request', 'the writer edits the run-owned linked workspace; a clone fallback is retained and never written to');
    if (!text(data.task) || data.task.trim().length === 0) fail('invalid_request', 'task must be a nonempty string');
    // The declared shape takes any nonempty string, and a hand-made object satisfying a predicate passes (CL-D44), so
    // the two spellings no filesystem call survives are refused here as they are in `builders.js`
    // (ADV-144-UNCHECKED-REQUEST-PATHS), and a relative cwd, which the receiver would resolve against its own
    // directory rather than the run's workspace, with it.
    const cwd = data.created.path;
    if (cwd.includes(String.fromCharCode(0)) || !cwd.isWellFormed()) fail('invalid_request', 'the workspace path carries a NUL byte or a lone surrogate');
    // `path.isAbsolute`, not the lexical spelling test: the receiver runs on this platform, and a drive spelling is
    // not absolute here (ADV152B-ABSOLUTE-SPELLING-NOT-PROCESS-CWD). The screens on a cwd a process is given read
    // the same predicate; the lexical test stays where a request field's spelling is what is judged.
    if (!path.isAbsolute(cwd)) fail('invalid_request', 'the workspace path must be absolute; a relative cwd resolves against the receiver, not the run');
    if (data.task.includes(String.fromCharCode(0)) || !data.task.isWellFormed()) fail('invalid_request', 'the task carries a NUL byte or a lone surrogate');
    return createResult(operation, { request: { ...WRITER_LAUNCH, task: data.task, cwd } });
  } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build', error.details);
  }
}

module.exports = { readGateResult, buildGateLaunch, buildWriterLaunch, runsRoot, ROLE_BY_GATE };

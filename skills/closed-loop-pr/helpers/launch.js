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
    // The boundary's own predicate table judges the cross-operation field first (CL-D44, CL-D68).
    const shapeProblem = inputShapeProblem('build_gate_launch', data);
    if (shapeProblem !== null) fail('input_shape_mismatch', shapeProblem);
    if (!text(data.expectationPath)) fail('invalid_request', 'expectationPath must be a nonempty string');
    // The path is interpolated into the task, so a delimiter in it would append prose to the payload
    // (ADV-123-EXPECTATION-PATH-INJECTION).
    if (/[\r\n`]/.test(data.expectationPath)) fail('invalid_request', 'expectationPath must not contain a line break or a backtick');
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
    if (JSON.stringify(data.expectation.outputSchema) !== JSON.stringify(SCHEMA)) fail('schema_mismatch', 'outputSchema is not the packaged CL-D36 schema byte for byte');
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
    const request = { agent, task: `${parts.join('\n\n')}\n`, context: 'fresh', async: true, outputMode: 'inline', acceptance: false, outputSchema: JSON.parse(JSON.stringify(SCHEMA)) };
    return createResult(operation, { request, blocks: blocks.map(({ file, heading, sha256: digest, bytes }) => ({ file, heading, sha256: digest, bytes })), packageRoot: PACKAGE_ROOT });
  } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build', error.details);
  }
}

module.exports = { readGateResult, buildGateLaunch, runsRoot, ROLE_BY_GATE };

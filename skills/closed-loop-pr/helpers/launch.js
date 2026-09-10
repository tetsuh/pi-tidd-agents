'use strict';

// Issue #111 (CL-D68). The two gate documents the parent still assembled by hand, packaged as a
// read-only reader and a read-only composer. `readGateResult` opens the runner's own status record
// for a run id and returns the envelope at that record's structured output path (CL-D58): the parent
// never chooses a path. `buildGateLaunch` composes the launch request from the built expectation and
// the installed package's own payload blocks (CL-D2, CL-D29): the schema is the builder's byte for
// byte, the blocks are copied verbatim with their digests recorded, and the request has no output
// field and no free-text envelope instruction. `helperTrust` names the helper that actually ran so
// operator_capture can refuse a helper resolved inside the reviewed checkout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createResult, createError } = require('./protocol');
const { SCHEMA, ROOT_GATES, expectedState } = require('./gate-result');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_PATH = path.join(__dirname, 'cli.js');
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// One table, pinned against the vocabulary source by test/issue-111-gate-read-launch.test.js.
const ROLE_BY_GATE = Object.freeze({ adversarial: 'tidd-adversarial-reviewer', 'decision-drift': 'tidd-drift-reviewer', safety: 'tidd-safety-reviewer', convergence: 'tidd-convergence-reviewer' });
const EVERY_GATE = Object.freeze({ file: 'skills/closed-loop-shared/references/gate-contract.md', heading: '#### Every-gate invariant payload block (CL-D2)' });
const SOL_ONLY = Object.freeze({ file: 'skills/closed-loop-shared/references/gate-contract.md', heading: '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)' });
// The volatile envelope is a closed, package-owned shape (the shared contract's volatile envelope and compact
// history projection): target, evidence fingerprints, the exact body or diff, Language Profile, acceptance
// criteria, and the compact gate history. No field carries an instruction; an unknown key never reaches the task.
const VOLATILE_FIELDS = Object.freeze({ target: 'object', fingerprints: 'object', body: 'string', diff: 'string', languageProfile: 'string', acceptanceCriteria: 'array', history: 'object', decisions: 'array', comments: 'array' });
const VOLATILE_REQUIRED = Object.freeze(['target', 'fingerprints', 'body']);
const ROLE_BLOCKS = Object.freeze({
  issue: Object.freeze({ file: 'skills/closed-loop-issue/SKILL.md', heading: '### Issue gate role-authority blocks (CL-D2)', label: 'Issue' }),
  pr: Object.freeze({ file: 'skills/closed-loop-pr/SKILL.md', heading: '### PR gate role-authority blocks (CL-D2)', label: 'PR' }),
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function readUtf8(file) { return fs.readFileSync(file, 'utf8'); }

// The runner's async-runs root for this user; fixtures override it.
function defaultRunsRoot() { return path.join(os.tmpdir(), `pi-subagents-uid-${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`, 'async-subagent-runs'); }

function readGateResult(data) {
  const operation = 'gate_result_read';
  try {
    if (!plain(data) || !text(data.runId) || !RUN_ID.test(data.runId)) fail('invalid_request', 'runId must be the runner run id (a UUID)');
    if (Object.hasOwn(data, 'runsRoot') && !text(data.runsRoot)) fail('invalid_request', 'runsRoot must be a nonempty string when given');
    const statusPath = path.join(data.runsRoot || defaultRunsRoot(), data.runId, 'status.json');
    let statusText;
    try { statusText = readUtf8(statusPath); } catch (error) { fail('status_absent', `runner status record is not readable: ${error.message}`, { statusPath }); }
    let status;
    try { status = JSON.parse(statusText); } catch (error) { fail('status_unparsable', `runner status record is not JSON: ${error.message}`, { statusPath }); }
    if (!plain(status) || status.runId !== data.runId) fail('run_mismatch', 'runner status record names a different run', { statusPath, recordedRunId: plain(status) ? status.runId ?? null : null });
    // The run state is reported, never decides: a validated envelope at the designated path is the verdict
    // whatever the runner's status says (CL-D58); the selected step's own completion is checked below.
    const steps = Array.isArray(status.steps) ? status.steps.filter((step) => plain(step) && text(step.structuredOutputPath)) : [];
    if (steps.length === 0) fail('designated_output_unrecorded', 'runner status record carries no structuredOutputPath', { statusPath });
    const step = steps[steps.length - 1];
    const structuredOutputPath = step.structuredOutputPath;
    // A completed run whose selected step failed, is still running, or carries no status is not a result,
    // whatever sits at its path (CONV-123-INCOMPLETE-STEP-READ).
    if (step.status !== 'complete') fail('step_incomplete', `selected step status is ${JSON.stringify(step.status ?? null)}`, { statusPath, structuredOutputPath, stepStatus: step.status ?? null });
    let outputText;
    try { outputText = readUtf8(structuredOutputPath); } catch (error) { fail('designated_output_absent', `designated output is not readable: ${error.message}`, { statusPath, structuredOutputPath }); }
    const bytes = Buffer.byteLength(outputText);
    if (outputText.trim().length === 0) fail('designated_output_empty', `designated output holds ${bytes} bytes and no content`, { statusPath, structuredOutputPath, bytes });
    let envelope;
    try { envelope = JSON.parse(outputText); } catch (error) { fail('designated_output_unparsable', `designated output is not JSON: ${error.message}`, { statusPath, structuredOutputPath, bytes }); }
    if (!plain(envelope)) fail('designated_output_unparsable', 'designated output is not a JSON object', { statusPath, structuredOutputPath, bytes });
    return createResult(operation, { statusPath, structuredOutputPath, bytes, state: status.state ?? null, stepStatus: step.status ?? null, envelope });
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
  return { block, sentence: line.slice(prefix.length, -1), label: `${source.label} ${nickname} role-authority block` };
}

function buildGateLaunch(data) {
  const operation = 'build_gate_launch';
  try {
    if (!plain(data) || !plain(data.expectation) || !plain(data.expectation.expected) || !plain(data.expectation.outputSchema)) fail('invalid_request', 'expectation must be the data of build_gate_expectation');
    if (!text(data.expectationPath)) fail('invalid_request', 'expectationPath must be a nonempty string');
    if (!plain(data.volatile)) fail('invalid_request', 'volatile must be a plain object');
    for (const key of Object.keys(data.volatile)) if (!Object.hasOwn(VOLATILE_FIELDS, key)) fail('volatile_unknown_field', `volatile carries an unknown field: ${key}`, { field: key, allowed: Object.keys(VOLATILE_FIELDS) });
    for (const key of VOLATILE_REQUIRED) if (!Object.hasOwn(data.volatile, key)) fail('invalid_request', `volatile lacks required field: ${key}`);
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
      blocks.push(role.block); parts.push(`${role.label}: ${role.sentence}`);
    }
    parts.push(`## Volatile envelope\n\n\`\`\`json\n${JSON.stringify(data.volatile, null, 2)}\n\`\`\``);
    // The expectation rides along as data: required-evidence identities are copied from here, never retyped (CL-D47, CL-D65).
    parts.push(`## Expectation (copy identities verbatim)\n\n\`\`\`json\n${JSON.stringify(expected, null, 2)}\n\`\`\``);
    parts.push(`Expectation file: ${data.expectationPath}\nPackaged validator: node ${CLI_PATH} (operation gate_result_validate, CL-D65)`);
    const request = { agent, task: `${parts.join('\n\n')}\n`, context: 'fresh', async: true, outputMode: 'inline', acceptance: false, outputSchema: JSON.parse(JSON.stringify(SCHEMA)) };
    return createResult(operation, { request, blocks: blocks.map(({ file, heading, sha256: digest, bytes }) => ({ file, heading, sha256: digest, bytes })), packageRoot: PACKAGE_ROOT });
  } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build', error.details);
  }
}

// The helper that ran, and whether it resolved inside the checkout under review.
function helperTrust(top) {
  const helperPath = fs.realpathSync.native(__dirname);
  const target = fs.realpathSync.native(top);
  const helperInsideTarget = helperPath === target || helperPath.startsWith(`${target}${path.sep}`);
  return { helperPath, helperInsideTarget };
}

module.exports = { readGateResult, buildGateLaunch, helperTrust, ROLE_BY_GATE, VOLATILE_FIELDS, VOLATILE_REQUIRED };

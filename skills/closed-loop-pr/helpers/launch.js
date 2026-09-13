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
const { SCHEMA, ROOT_GATES, expectedState } = require('./gate-result');
const { inputShapeProblem } = require('./composition');
const { FINGERPRINT_DOMAINS } = require('./evidence');

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
// The complete CL-D2 envelope for the gate being composed: the diff is the PR root's exact change, and
// Sol's authoritative decisions and comments are its own duty (CL-D29). The gate correlation is derived
// from the expectation below, never supplied (ADV-123-VOLATILE-REQUIRED-FIELDS).
const VOLATILE_EVERY_GATE = Object.freeze(['target', 'fingerprints', 'body', 'languageProfile', 'acceptanceCriteria', 'history']);
function volatileRequired(workflow, gate) {
  return [...VOLATILE_EVERY_GATE, ...(workflow === 'pr' ? ['diff'] : []), ...(gate === 'adversarial' ? ['decisions', 'comments'] : [])];
}
// Each declared object of the envelope is closed too: an unknown key anywhere in it is caller prose that
// would ride into the task (ADV-123-NESTED-VOLATILE-ENVELOPE-PROSE). A record inside the history arrays is
// the parent ledger's projection, whose fields CL-D2 owns; the composer owns the envelope around it.
const OID_TEXT = /^[0-9a-f]{40}$/, HEX_TEXT = /^[0-9a-f]{40,64}$/;
const TARGET_FIELDS = Object.freeze({
  repository: (v) => typeof v === 'string' && v.length > 0, headRepository: (v) => typeof v === 'string' && v.length > 0,
  number: (v) => Number.isInteger(v) && v > 0,
  mode: (v) => typeof v === 'string', gate: (v) => typeof v === 'string',
  headBranch: (v) => typeof v === 'string' && v.length > 0,
  baseOid: (v) => typeof v === 'string' && OID_TEXT.test(v), headOid: (v) => typeof v === 'string' && OID_TEXT.test(v),
});
const HISTORY_FIELDS = Object.freeze(['unresolved', 'reopened', 'settled']);
// A history record is a finding record or a settled summary: the finding fields the packaged schema declares,
// plus the projection fields CL-D2 names for a settled or reopened entry. Every record names its finding.
const HISTORY_RECORD_FIELDS = Object.freeze([...Object.keys(SCHEMA.properties.findings.items.properties),
  'sourceGate', 'raisedAgainst', 'disposition', 'dispositionRationale', 'confirmation', 'status', 'reviewedHead', 'summary']);
// The one declared object inside a record is closed by the same schema (CONV-123-HISTORY-RECORD-CLOSURE).
const WORKFLOW_RECORD_FIELDS = Object.freeze(Object.keys(SCHEMA.properties.findings.items.properties.workflowRecord.properties));
// The evidence identities the correlation already fixes; a repeated one must agree with it.
const FINGERPRINT_CORRELATED = Object.freeze({ pr_head: 'headOid', pr_base: 'baseOid', snapshot: 'snapshotFingerprint' });
const RECORD_LISTS = Object.freeze(['decisions', 'comments']);
// A decision or comment is a record the gate cites: its identity, its author, when it was written, and its
// body, which is the target's own text. The package owns this shape. GitHub's own issue-comment record is
// read by the fields it declares and reduced to it, so nothing GitHub adds, and nothing a caller adds to it,
// is serialized; rejecting GitHub's undeclared fields would make the composer the owner of GitHub's schema,
// which has changed twice in the observed records (CONV-123-NESTED-RECORD-PROSE).
const CITED_RECORD_FIELDS = Object.freeze({
  // GitHub's identity is an integer; a parent that has already projected it carries it as digits.
  id: (v) => (Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9][0-9]*$/.test(v)), url: (v) => typeof v === 'string' && v.length > 0,
  author: (v) => typeof v === 'string' && v.length > 0, authorType: (v) => typeof v === 'string' && v.length > 0,
  authorAssociation: (v) => typeof v === 'string' && v.length > 0, createdAt: (v) => typeof v === 'string' && v.length > 0,
  updatedAt: (v) => typeof v === 'string' && v.length > 0, body: (v) => typeof v === 'string',
});
const CITED_RECORD_REQUIRED = Object.freeze(['id', 'url', 'author', 'updatedAt', 'body']);
function citedRecord(field, record) {
  if (!plain(record) || Object.keys(record).length === 0) return { problem: { code: 'invalid_request', message: `volatile field ${field} must be a list of records` } };
  let projected = record;
  if (plain(record.user)) {
    const github = { id: record.id, url: record.html_url, author: record.user.login, authorType: record.user.type, authorAssociation: record.author_association, createdAt: record.created_at, updatedAt: record.updated_at, body: record.body };
    projected = Object.fromEntries(Object.entries(github).filter(([, value]) => value !== undefined && value !== null));
  }
  for (const [key, value] of Object.entries(projected)) {
    if (!Object.hasOwn(CITED_RECORD_FIELDS, key)) return { problem: { code: 'volatile_unknown_field', message: `volatile carries an unknown field: ${field}[].${key}` } };
    if (!CITED_RECORD_FIELDS[key](value)) return { problem: { code: 'invalid_request', message: `volatile field ${field}[].${key} is not the declared shape` } };
  }
  for (const key of CITED_RECORD_REQUIRED) if (!Object.hasOwn(projected, key)) return { problem: { code: 'invalid_request', message: `volatile field ${field}[] must carry ${key}` } };
  return { record: projected };
}
// The cited lists, reduced; or the first problem among them.
function citedRecords(v) {
  const lists = {};
  for (const field of RECORD_LISTS) {
    if (!Object.hasOwn(v, field)) continue;
    lists[field] = [];
    for (const record of v[field]) {
      const cited = citedRecord(field, record);
      if (cited.problem) return { problem: cited.problem };
      lists[field].push(cited.record);
    }
  }
  return { lists };
}
// The evidence identities each root's gates review (CL-D9), and the two modes CL-D6 parses.
const FINGERPRINT_MINIMUM = Object.freeze({ pr: FINGERPRINT_DOMAINS, issue: ['issue_spec', 'snapshot'] });
const MODES = Object.freeze(['autofix', 'review-only']);
// The identities a target may repeat. The expectation is the authority for each; the target's copy is
// checked against it rather than trusted, and a copy it does not carry is not required (CL-D47's rule).
const TARGET_CORRELATED = Object.freeze(['repository', 'number', 'baseOid', 'headOid', 'headBranch', 'headRepository']);
// A required field that carries nothing is not the envelope: an empty target names no target, an empty body
// no content, no criteria no scope (ADV-123-VOLATILE-REQUIRED-FIELDS). `decisions` and `comments` may be
// empty, because a target can legitimately carry neither.
// Every declared object, key by key, before any of it is serialized.
function nestedProblem(v, correlation) {
  for (const [key, value] of Object.entries(v.target)) {
    if (!Object.hasOwn(TARGET_FIELDS, key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: target.${key}` };
    if (!TARGET_FIELDS[key](value)) return { code: 'invalid_request', message: `volatile field target.${key} is not the declared shape` };
  }
  for (const [key, value] of Object.entries(v.fingerprints)) {
    if (!FINGERPRINT_DOMAINS.includes(key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: fingerprints.${key}` };
    if (typeof value !== 'string' || !HEX_TEXT.test(value)) return { code: 'invalid_request', message: `volatile field fingerprints.${key} is not an evidence identity` };
    const correlated = FINGERPRINT_CORRELATED[key];
    if (correlated && value !== correlation[correlated]) return { code: 'invalid_request', message: `volatile field fingerprints.${key} disagrees with the expectation on ${correlated}` };
  }
  for (const [key, value] of Object.entries(v.history)) {
    if (!HISTORY_FIELDS.includes(key)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}` };
    if (!Array.isArray(value) || value.some((record) => !plain(record))) return { code: 'invalid_request', message: `volatile field history.${key} must be a list of records` };
    for (const record of value) {
      for (const field of Object.keys(record)) {
        if (!HISTORY_RECORD_FIELDS.includes(field)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}[].${field}` };
      }
      if (typeof record.findingId !== 'string' || record.findingId.length === 0) return { code: 'invalid_request', message: `volatile field history.${key} carries a record naming no finding` };
      // Every value in a record is a scalar, and the one declared object holds scalars: nothing deeper can
      // be composed, so no structure carries prose past the declared names.
      for (const [field, value] of Object.entries(record)) {
        if (field === 'workflowRecord') {
          if (!plain(value)) return { code: 'invalid_request', message: `volatile field history.${key}[].workflowRecord must be a record` };
          for (const [inner, held] of Object.entries(value)) {
            if (!WORKFLOW_RECORD_FIELDS.includes(inner)) return { code: 'volatile_unknown_field', message: `volatile carries an unknown field: history.${key}[].workflowRecord.${inner}` };
            if (!scalar(held)) return { code: 'invalid_request', message: `volatile field history.${key}[].workflowRecord.${inner} is not a value` };
          }
          continue;
        }
        if (!scalar(value)) return { code: 'invalid_request', message: `volatile field history.${key}[].${field} is not a value` };
      }
    }
  }
  return null;
}
function volatileEmptiness(expected, v) {
  const workflow = expected.workflow, correlation = expected.correlation;
  const filled = (value) => typeof value === 'string' && value.trim().length > 0;
  const bad = (field, why) => `volatile field ${field} ${why}`;
  if (!filled(v.body)) return bad('body', 'must carry the exact body under review');
  if (workflow === 'pr' && !filled(v.diff)) return bad('diff', 'must carry the exact diff under review');
  if (!filled(v.languageProfile)) return bad('languageProfile', 'must name the Language Profile');
  if (!v.acceptanceCriteria.length || !v.acceptanceCriteria.every(filled)) return bad('acceptanceCriteria', 'must carry at least one criterion');
  if (!filled(v.target.repository) || !Number.isInteger(v.target.number) || v.target.number < 1) return bad('target', 'must name the repository and the target number');
  // The target is complete or it is not the target: the head it reviews, the base it is measured against,
  // and the branch it sits on, each checked against the expectation below.
  for (const key of ['baseOid', 'headOid', 'headBranch']) if (!filled(v.target[key])) return bad('target', `must name ${key}`);
  // CL-D2's mode or gate correlation: the gate is the expectation's, and the mode is one CL-D6 parses.
  if (!MODES.includes(v.target.mode)) return bad('target', `must name the mode, one of ${MODES.join(', ')}`);
  if (v.target.gate !== correlation.gate) return bad('target', `must name the gate the expectation names: ${correlation.gate}`);
  for (const key of TARGET_CORRELATED) {
    if (Object.hasOwn(v.target, key) && v.target[key] !== correlation[key]) return bad('target', `disagrees with the expectation on ${key}`);
  }
  for (const key of FINGERPRINT_MINIMUM[workflow]) if (!filled(v.fingerprints[key])) return bad('fingerprints', `must carry ${key}`);
  for (const [key, value] of Object.entries(v.fingerprints)) if (!filled(value)) return bad('fingerprints', `carries an empty ${key}`);
  // The compact projection is complete or it is not the projection: a child without the reopened list cannot
  // see which settled findings came back (CL-D2, CONV-123-HISTORY-REOPENED-OMISSION).
  for (const key of HISTORY_FIELDS) if (!Array.isArray(v.history[key])) return bad('history', `must carry the ${key} projection`);
  return null;
}
const ROLE_BLOCKS = Object.freeze({
  issue: Object.freeze({ file: 'skills/closed-loop-issue/SKILL.md', heading: '### Issue gate role-authority blocks (CL-D2)', label: 'Issue' }),
  pr: Object.freeze({ file: 'skills/closed-loop-pr/SKILL.md', heading: '### PR gate role-authority blocks (CL-D2)', label: 'PR' }),
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'; }
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
    // The packaged request names a run, never a place to read it from: the CLI schema carries no
    // `runsRoot`, so a caller cannot point the read at a forged root (SAFETY-123-RUNSROOT-OVERRIDE).
    // The override below is reachable only by a direct in-process call, which is the fixture's.
    if (Object.hasOwn(data, 'runsRoot') && !text(data.runsRoot)) fail('invalid_request', 'runsRoot must be a nonempty string when given');
    const statusPath = path.join(data.runsRoot || defaultRunsRoot(), data.runId, 'status.json');
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
    const nested = nestedProblem(data.volatile, expected.correlation);
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

module.exports = { readGateResult, buildGateLaunch, ROLE_BY_GATE, VOLATILE_FIELDS, volatileRequired, FINGERPRINT_DOMAINS };

'use strict';

// Issue #184 (CL-D90) — gate launches failed before any verdict because the `outputSchema` the parent passed to the subagent
// tool was not the packaged schema: the parent re-typed a ~11 KB JSON document as tool-call arguments and displaced
// every `required` array into its object's `properties`. The provider rejected it. Seen in a consumer repository on
// several PRs and here on PR #182 (round 4). The four gate roles now carry the packaged schema in their agent
// definitions, `build_gate_launch` puts no schema in the request, and `gate_result_read` names a child whose schema
// differs from the packaged one instead of leaving a provider message.
//
// TDD provenance: behavioural RED — the agent files carry no schema, the launch request carries one, and a displaced
// schema reads as an ordinary step failure before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText } = require('./helpers');

const GATE_ROLES = ['tidd-convergence-reviewer', 'tidd-adversarial-reviewer', 'tidd-safety-reviewer', 'tidd-drift-reviewer'];
const RUN = '7305b50a-2708-4e55-8364-d72f11197fbe';
function frontmatterSchema(agent) {
  const text = readText(`agents/${agent}.md`);
  const frontmatter = text.slice(4, text.indexOf('\n---\n', 4));
  const lines = frontmatter.split('\n').filter((line) => line.startsWith('outputSchema:'));
  assert.equal(lines.length, 1, `${agent} declares outputSchema exactly once`);
  return JSON.parse(lines[0].slice('outputSchema:'.length).trim());
}
// The displaced form #184 recorded: every `required` moved inside `properties`, and the object has none of its own.
function displaced(schema) {
  if (Array.isArray(schema)) return schema.map(displaced);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) if (key !== 'required') out[key] = displaced(value);
  if (Array.isArray(schema.required) && out.properties) out.properties = { ...out.properties, required: schema.required };
  return out;
}
// A runner record as pi-subagents 0.71 writes it: the step records both the output and the schema it ran with
// (`structuredOutputSchemaPath`, subagent-runner.js), beside each other in the run directory.
function runRecord(root, schema, stepStatus, { schemaPath, output } = {}) {
  const dir = path.join(root, RUN);
  fs.mkdirSync(path.join(dir, 'structured-output', 'x'), { recursive: true });
  const structuredOutputPath = path.join(dir, 'structured-output', 'x', 'output.json');
  const structuredOutputSchemaPath = schemaPath || path.join(dir, 'structured-output', 'x', 'schema.json');
  if (!schemaPath) fs.writeFileSync(structuredOutputSchemaPath, JSON.stringify(schema));
  if (output !== undefined) fs.writeFileSync(structuredOutputPath, JSON.stringify(output));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: RUN, state: stepStatus === 'complete' ? 'complete' : 'failed', steps: [{ agent: 'tidd-adversarial-reviewer', status: stepStatus, structuredOutputPath, structuredOutputSchemaPath }] }));
  return structuredOutputPath;
}

test('Issue #184 every gate role carries the packaged schema in its definition', () => {
  for (const agent of GATE_ROLES) assert.deepEqual(frontmatterSchema(agent), SCHEMA, `${agent} outputSchema is gate-result.js SCHEMA exactly`);
  // The writer is not a gate and returns no gate envelope.
  assert.doesNotMatch(readText('agents/tidd-autofix-worker.md'), /^outputSchema:/m);
});

test('Issue #184 the packaged launch request carries no schema for the parent to transcribe', () => {
  const source = readText('skills/closed-loop-pr/helpers/launch.js');
  const requestLine = source.split('\n').find((line) => line.includes('const request = { agent, task:'));
  assert.ok(requestLine, 'the request literal is where it was');
  assert.doesNotMatch(requestLine, /outputSchema/, 'the request names no outputSchema; the agent definition carries it');
});

test('Issue #184 gate_result_read names a child that ran with a schema other than the packaged one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i184-runs-'));
  try {
    // The provider rejected the displaced schema, so the step failed with no output: the read says why.
    runRecord(root, displaced(SCHEMA), 'failed');
    const read = helpers.readGateResult({ runId: RUN, runsRoot: root });
    assert.deepEqual([read.ok, read.error?.code], [false, 'schema_transcription_mismatch'], JSON.stringify(read));
    assert.match(read.error.message, /\/required|\/properties\/required/, 'the first differing JSON path is named');
    // The packaged schema reads on to the ordinary step result.
    fs.rmSync(path.join(root, RUN), { recursive: true, force: true });
    runRecord(root, SCHEMA, 'failed');
    const ordinary = helpers.readGateResult({ runId: RUN, runsRoot: root });
    assert.equal(ordinary.error?.code, 'step_incomplete', JSON.stringify(ordinary));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #184 the schema read stays inside the run and a matching schema reads on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i184-runs-'));
  try {
    // A recorded schema path outside the run directory is never read, whatever it holds.
    const outside = path.join(root, 'foreign-schema.json');
    fs.writeFileSync(outside, JSON.stringify(displaced(SCHEMA)));
    runRecord(root, null, 'failed', { schemaPath: outside });
    const foreign = helpers.readGateResult({ runId: RUN, runsRoot: root });
    assert.equal(foreign.error?.code, 'designated_output_outside_run', JSON.stringify(foreign));
    // A symlink inside the run that resolves outside it is outside too.
    fs.rmSync(path.join(root, RUN), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, RUN, 'structured-output', 'x'), { recursive: true });
    const link = path.join(root, RUN, 'structured-output', 'x', 'schema.json');
    fs.symlinkSync(outside, link);
    runRecord(root, null, 'failed', { schemaPath: link });
    assert.equal(helpers.readGateResult({ runId: RUN, runsRoot: root }).error?.code, 'designated_output_outside_run');
    // A complete step whose schema is the packaged one reads its envelope.
    fs.rmSync(path.join(root, RUN), { recursive: true, force: true });
    const envelope = { schemaVersion: 2, correlation: {}, verdict: 'MERGE', evidenceRead: [], findings: [], confirmations: [], decisions: [], adversarialResults: [] };
    runRecord(root, SCHEMA, 'complete', { output: envelope });
    const read = helpers.readGateResult({ runId: RUN, runsRoot: root });
    assert.equal(read.ok, true, JSON.stringify(read));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #184 the schema reaches no document the parent composes', () => {
  // build_gate_expectation no longer returns it, so the parent carries it into no later request.
  const built = helpers.buildGateExpectation({ workflow: 'pr', correlation: { repository: 'o/r', number: 1, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'x', lifecycle: 'open', draft: false, gate: 'adversarial', invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) }, assignedFindings: [], requiredEvidence: [{ source: 'README.md', kind: 'file', identity: '1'.repeat(64) }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(Object.keys(built.data).sort(), ['expected']);
  // No workflow prose tells the parent to pass or request a schema itself.
  for (const file of ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md']) {
    assert.doesNotMatch(readText(file), /requests? (?:the )?(?:same )?packaged (?:closed result )?schema through (?:its )?`outputSchema`/, `${file} no longer tells the parent to request the schema`);
  }
});

test('Issue #184 a child schema that is unrecorded, missing, or unreadable is refused, not skipped', () => {
  // CONV-187-SCHEMA-READ-FAILOPEN: a gate that ran without the packaged schema, such as a replacement definition that
  // declares none (CONV-187-CUSTOM-GATE-SCHEMA), leaves no schema or another one. Neither may read on as a result.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i184-runs-'));
  const envelope = { schemaVersion: 2, correlation: {}, verdict: 'MERGE', evidenceRead: [], findings: [], confirmations: [], decisions: [], adversarialResults: [] };
  const writeRun = (step, schemaText) => {
    fs.rmSync(path.join(root, RUN), { recursive: true, force: true });
    const dir = path.join(root, RUN, 'structured-output', 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(envelope));
    if (schemaText !== undefined) fs.writeFileSync(path.join(dir, 'schema.json'), schemaText);
    fs.writeFileSync(path.join(root, RUN, 'status.json'), JSON.stringify({ runId: RUN, state: 'complete', steps: [{ agent: 'tidd-adversarial-reviewer', status: 'complete', structuredOutputPath: path.join(dir, 'output.json'), ...step(dir) }] }));
  };
  try {
    for (const [label, step, schemaText, code] of [
      ['unrecorded', () => ({}), undefined, 'designated_schema_unrecorded'],
      ['recorded but missing', (dir) => ({ structuredOutputSchemaPath: path.join(dir, 'schema.json') }), undefined, 'designated_schema_unreadable'],
      ['recorded but not JSON', (dir) => ({ structuredOutputSchemaPath: path.join(dir, 'schema.json') }), '{', 'designated_schema_unreadable'],
    ]) {
      writeRun(step, schemaText);
      const read = helpers.readGateResult({ runId: RUN, runsRoot: root });
      assert.deepEqual([read.ok, read.error?.code], [false, code], `${label}: ${JSON.stringify(read)}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #184 a replacement gate definition must declare the packaged schema', () => {
  assert.match(readText('README.md'), /A replacement definition of a gate role must declare the same `outputSchema` as the packaged one \(CL-D90\); a gate that ran without it is refused when its result is read\./);
  assert.match(readText('skills/closed-loop-shared/references/gate-contract.md'), /A replacement definition of a gate role must declare the same `outputSchema`; a result whose child ran without the packaged schema is refused when read\./);
});

test('Issue #184 the helper map says the expectation carries no schema', () => {
  // CONV-187-SCHEMA-DOCS: the builder paragraph still said build_gate_expectation returns the schema.
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.doesNotMatch(map, /`build_gate_expectation` additionally returns the canonical CL-D36 structured-output schema/);
  assert.match(map, /`build_gate_expectation` returns only `expected`; the gate roles' agent definitions supply the CL-D36 `outputSchema`, so no document the parent composes carries it \(CL-D90\)\./);
});

test('Issue #184 the shared contract says where the schema comes from', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(contract, /The packaged closed result schema is declared in each gate role's agent definition \(`outputSchema`, #184\); a launch request carries none, and the parent never adds one\./);
});

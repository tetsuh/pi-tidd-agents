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
function runRecord(root, schema, stepStatus) {
  const dir = path.join(root, RUN);
  fs.mkdirSync(path.join(dir, 'structured-output', 'x'), { recursive: true });
  const structuredOutputPath = path.join(dir, 'structured-output', 'x', 'output.json');
  fs.writeFileSync(path.join(dir, 'structured-output', 'x', 'schema.json'), JSON.stringify(schema));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: RUN, state: stepStatus === 'complete' ? 'complete' : 'failed', steps: [{ agent: 'tidd-adversarial-reviewer', status: stepStatus, structuredOutputPath }] }));
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

test('Issue #184 the shared contract says where the schema comes from', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(contract, /The packaged closed result schema is declared in each gate role's agent definition \(`outputSchema`, #184\); a launch request carries none, and the parent never adds one\./);
});

'use strict';

// Issue #55 / CL-D30 (Issue #47 amendment): the packaged helper CLI is bound to the
// exact-autofix phases that invoke it, so the orchestrator stops regenerating the same
// logic as run-time shell, jq, Python, or GraphQL. Compile/contract coverage: these
// assertions prove the reference names the real operation surface, not that a model
// obeys it at run time.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText } = require('./helpers');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const PR_CLI = 'skills/closed-loop-pr/helpers/cli.js';

// `cli.js` runs its own main on require and blocks on stdin, so the operation surface is
// read from its source rather than imported. Parsing the frozen SCHEMAS table keeps this
// check bound to the shipped code instead of to a second copy of the operation list.
function cliSchemas() {
  const source = readText(PR_CLI);
  const table = source.match(/const SCHEMAS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(table, `could not locate the SCHEMAS table in ${PR_CLI}`);
  const schemas = {};
  for (const [, operation, required] of table[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*\{\s*required:\s*\[([^\]]*)\]/gm)) {
    schemas[operation] = (required.match(/'([^']+)'/g) || []).map((field) => field.slice(1, -1));
  }
  assert.ok(Object.keys(schemas).length > 0, 'parsed no operations from the CLI schema table');
  return schemas;
}
const MAP_HEADING = '### Packaged helper invocation map (CL-D30, Issue #47)';

function sectionOf(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(#+)\s/);
    if (match && match[1].length <= depth) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

const mapSection = () => sectionOf(readText(PR_AUTOFIX), MAP_HEADING);
// Backtick-quoted snake_case names are the operation mentions; other inline code in the
// map (request fields such as `cwd`, JSON literals) never matches this shape.
const namedOperations = (text) => new Set((text.match(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g) || []).map((token) => token.slice(1, -1)));

test('Issue #55 the exact-autofix reference carries a packaged helper invocation map', () => {
  const section = mapSection();
  assert.ok(section, `${PR_AUTOFIX} is missing the packaged helper invocation map`);
  assert.match(section, /\| Phase \| Operation \| Required data \|/, 'the map must be a phase/operation/data table');
  assert.match(section, /one JSON v1 request on stdin/i);
  assert.match(section, /one JSON v1 envelope on stdout/i);
  assert.match(section, /`ok:false`[^.]*stops the run at that phase with its `code` and `phase`/);
  assert.match(section, /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/);
});

test('Issue #55 the map and the CLI schema table agree in both directions', () => {
  const section = mapSection();
  const exposed = new Set(Object.keys(cliSchemas()));
  const named = namedOperations(section);
  const missing = [...exposed].filter((operation) => !named.has(operation)).sort();
  const unknown = [...named].filter((operation) => !exposed.has(operation)).sort();
  assert.deepEqual(missing, [], `operations exposed by the CLI but absent from the map: ${missing.join(', ')}`);
  assert.deepEqual(unknown, [], `operations named by the map but absent from the CLI: ${unknown.join(', ')}`);
});

test('Issue #55 every mapped operation names its required request fields', () => {
  const section = mapSection();
  for (const [operation, required] of Object.entries(cliSchemas())) {
    const row = section.split('\n').find((line) => line.includes(`\`${operation}\``));
    assert.ok(row, `no map row names ${operation}`);
    // Fingerprint rows are grouped, so their per-operation fields are documented by the CLI
    // schema itself; identity, policy, and workspace rows must spell their fields out.
    if (operation.startsWith('fingerprint_')) continue;
    for (const field of required) {
      assert.ok(row.includes(`\`${field}\``), `map row for ${operation} omits required field ${field}`);
    }
  }
});

test('Issue #55 the map preserves the linked/clone postPushHead distinction and grants no authority', () => {
  const section = mapSection();
  assert.match(section, /linked[^.]*`postPushHead: C`/);
  assert.match(section, /clone omits it and requires `O` equality/);
  assert.match(section, /supplied evidence/);
  assert.match(section, /never substitutes for a gate verdict/);
  assert.match(section, /grants no commit, push, reply, or provider authority/);
});

test('Issue #55 the retired one-line CLI reference does not survive beside the map', () => {
  const text = readText(PR_AUTOFIX);
  assert.doesNotMatch(text, /Use packaged `helpers\/cli\.js` v1; errors stop\./, 'the superseded one-line reference must be replaced by the map');
  assert.equal((text.match(/### Packaged helper invocation map/g) || []).length, 1, 'the map must appear exactly once');
});

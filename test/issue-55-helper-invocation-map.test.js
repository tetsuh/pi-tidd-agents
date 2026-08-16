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
// Read the Operation column only. Scanning the whole section would both miss nothing and
// pick up request fields such as `cwd`, so the column boundary is what makes the
// both-directions check meaningful.
function mapRows(section) {
  return section.split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Phase \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      assert.equal(cells.length, 3, `map row must have three columns: ${line}`);
      return { phase: cells[0], operation: cells[1], data: cells[2] };
    });
}
const backticked = (cell) => (cell.match(/`([^`]+)`/g) || []).map((token) => token.slice(1, -1));
const namedOperations = (section) => new Set(mapRows(section).flatMap((row) => backticked(row.operation)).filter((token) => /^[a-z][a-z0-9_]*$/.test(token)));

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
  const rows = mapRows(section);
  for (const [operation, required] of Object.entries(cliSchemas())) {
    const matching = rows.filter((row) => backticked(row.operation).includes(operation));
    assert.ok(matching.length > 0, `no map row names ${operation}`);
    for (const field of required) {
      assert.ok(matching.some((row) => backticked(row.data).includes(field)), `map row for ${operation} omits required field ${field}`);
    }
  }
});

// The packaged `workspace_verify` rejects any tracked or index change as
// `workspace_not_clean` (helpers/workspace.js `verifyWorkspaceState`). Luna's post-edit
// guards deliberately carry a frozen overlay or a staged-manifest delta, so mapping them to
// this operation would fail every non-empty correction before validation or commit.
const DIRTY_GUARDS = ['BEFORE_VALIDATION', 'AFTER_VALIDATION', 'BEFORE_STAGING', 'AFTER_STAGING', 'BEFORE_COMMIT'];

test('Issue #55 clean-only workspace verification is not mapped to a guard that permits dirt', () => {
  const section = mapSection();
  for (const row of mapRows(section)) {
    if (!backticked(row.operation).includes('workspace_verify')) continue;
    for (const guard of DIRTY_GUARDS) {
      assert.ok(!row.phase.includes(guard), `${guard} permits a frozen overlay or staged-manifest delta and must not be mapped to clean-only workspace_verify`);
    }
  }
  assert.match(section, /`workspace_verify` requires clean tracked and index state/);
  for (const guard of DIRTY_GUARDS) {
    assert.ok(section.includes(`\`${guard}\``), `the map must name ${guard} as keeping its phase-specific check`);
  }
  assert.match(section, /keep their phase-specific frozen-overlay and staged-manifest delta checks, which this map does not reassign/);
  // The clean-state row must still exist for the pre-edit boundaries it does serve.
  assert.ok(mapRows(section).some((row) => backticked(row.operation).includes('workspace_verify') && /before any edit/.test(row.phase)));
});

// autofix.md requires a refreshed snapshot, `AUTOFIX_WORKSPACE@H`, and
// `OPERATOR_CHECKOUT_UNCHANGED@O` at reply, final-classification, post-reply, and summary
// boundaries, not only at gate boundaries. A map that names gates alone silently drops them.
const MANDATORY_BOUNDARIES = ['reply', 'final classification', 'final-classification', 'post-reply', 'summary'];
const boundaryPhase = (section, operation) => mapRows(section).filter((row) => backticked(row.operation).includes(operation) && !/transition/.test(row.data)).map((row) => row.phase).join(' ');

test('Issue #55 non-gate mandatory boundaries are mapped, not only gate boundaries', () => {
  const section = mapSection();
  for (const operation of ['snapshot', 'workspace_verify', 'operator_revalidate']) {
    const phase = boundaryPhase(section, operation);
    assert.ok(phase, `no non-transition row maps ${operation}`);
    for (const marker of ['reply', 'final classification', 'final-classification', 'post-reply', 'summary']) {
      if (marker === 'final classification' && phase.includes('final-classification')) continue;
      if (marker === 'final-classification' && phase.includes('final classification')) continue;
      assert.ok(phase.includes(marker), `${operation} phase cell omits the ${marker} boundary`);
    }
  }
  assert.ok(MANDATORY_BOUNDARIES.length > 0);
});

test('Issue #55 the transition form is described as partial invariant evidence', () => {
  const section = mapSection();
  const row = mapRows(section).find((r) => backticked(r.data).includes('transition'));
  assert.ok(row, 'no row maps the transition form');
  assert.match(row.phase, /Sole-parent transition evidence toward/, 'the transition row must not claim to establish the full invariants');
  assert.match(section, /Its transition form supplies only clean workspace identity, current `HEAD`, and a verified sole-parent transition/);
  assert.match(section, /current public-head equality, staged manifest\/tree\/blob identity, and linked remote-tracking equality remain phase-specific checks this map does not reassign/);
});

test('Issue #55 the map preserves the linked/clone postPushHead distinction and grants no authority', () => {
  const section = mapSection();
  // The exact literal is pinned elsewhere by test/pr-operational-cleanliness.test.js; the
  // map must carry it verbatim rather than a reworded variant.
  assert.match(section, /After public\/workspace `C`, linked alone passes `postPushHead:C`; clone omits it and requires `O` equality/);
  assert.match(section, /supplied evidence in the gate payload/);
  assert.match(section, /never substitutes for a gate verdict/);
  assert.match(section, /grants no commit, push, reply, or provider authority/);
});

test('Issue #55 the retired one-line CLI reference does not survive beside the map', () => {
  const text = readText(PR_AUTOFIX);
  assert.doesNotMatch(text, /Use packaged `helpers\/cli\.js` v1; errors stop\./, 'the superseded one-line reference must be replaced by the map');
  assert.equal((text.match(/### Packaged helper invocation map/g) || []).length, 1, 'the map must appear exactly once');
});

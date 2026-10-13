'use strict';

// Issue #287: pi-subagents 0.77.0 split the `subagent` tool schema. `SubagentParams` keeps a dozen top-level fields and
// an untyped `options`; `SubagentFlatParams` declares every field with its type; a tool call passes through
// `flattenSubagentToolOptions`, which keeps top-level fields as given. The receiver regression (issue-152, issue-159)
// reads the names and types from the flat schema and checks the tool path; CL-D81 and CL-D25 say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readText } = require('./helpers');

test('Issue #287 the receiver regression reads the flat schema and drives the tool path', () => {
  for (const file of ['test/issue-152-writer-launch.test.js', 'test/issue-159-gate-launch-cwd.test.js']) {
    const text = readText(file);
    assert.ok(text.includes('schemas.SubagentFlatParams ?? schemas.SubagentParams'), `${file} reads the flat schema`);
    assert.ok(text.includes("load('src/extension/subagent-options.js')"), `${file} loads the tool path where the receiver has it`);
  }
});

test('Issue #287 CL-D81 names the schema the regression runs, and CL-D25 records the validated receiver', () => {
  assert.match(readText('contract/CL-D81.md'), /the receiver's flat parameter schema \(`SubagentParams`, and from 0\.77\.0 `SubagentFlatParams`, #287\), run over the document and not only read for the names it declares/);
  const d25 = readText('contract/CL-D25.md');
  assert.match(d25, /pi-subagents 0\.78\.0 is validated \(#287\)\./);
  assert.match(d25, /so its schema no longer types the `context`, `outputMode`, `acceptance`, `timeoutMs` and `checkpointBeforeDeadlineMs` the builders emit at the top level; the receiver's flat schema still types each of them, the builders' own tests hold their values/);
});

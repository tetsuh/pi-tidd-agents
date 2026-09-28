'use strict';

// Issue #197 — pi-subagents 0.72.0 stopped bundling TypeBox ("TypeBox is now provided by Pi instead of bundled with
// the package"), so its schema module no longer loads under plain Node and every receiver case failed on main with
// `Cannot find package 'typebox'`. The loader now resolves it where pi supplies it: the installed pi package.
//
// TDD provenance: behavioural RED — the receiver cases fail on main (1f3ef08) with pi-subagents 0.73.1; the helper
// below does not exist before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helpers = require('./helpers');

test('Issue #197 the receiver typebox resolves from the installed pi package when the receiver does not carry it', async (t) => {
  assert.equal(typeof helpers.receiverTypebox, 'function', 'test/helpers.js exports receiverTypebox');
  const receiver = path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
  if (!fs.existsSync(receiver)) { t.skip('pi-subagents is not installed in this environment'); return; }
  const source = helpers.receiverTypebox(receiver);
  assert.match(source.from, /^(?:receiver|pi)$/, `the source is named: ${JSON.stringify(source)}`);
  const schemas = await import(pathToFileURL(path.join(receiver, 'src/extension/schemas.js')).href);
  assert.equal(typeof schemas.SubagentParams, 'object', 'the receiver schema module loads');
});

test('Issue #197 with no pi package the loader names the state instead of guessing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'i197-'));
  fs.writeFileSync(path.join(empty, 'package.json'), '{"name":"pi-subagents","version":"0.73.1"}');
  const source = helpers.receiverTypebox(empty, { pathEnv: '' });
  assert.equal(source.from, null);
  assert.match(source.problem, /cannot resolve its own typebox/);
});

test('Issue #197 CL-D25 names where typebox comes from on 0.72 and later', () => {
  const record = helpers.sectionOf(helpers.readText('CONTRACT.md'), '## CL-D25 — Validated `pi-subagents` minimum, and what a normal commit is');
  assert.match(record, /From `0\.72\.0` pi-subagents takes `typebox` from pi rather than bundling it/);
});

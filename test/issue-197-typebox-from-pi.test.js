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
const { spawnSync } = require('node:child_process');

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
  const source = helpers.receiverTypebox(empty, { pathEnv: '', prefixes: [] });
  assert.equal(source.from, null);
  assert.match(source.problem, /cannot resolve its own typebox/);
});

test('Issue #197 CL-D25 names where typebox comes from on 0.72 and later', () => {
  const record = helpers.sectionOf(helpers.readText('CONTRACT.md'), '## CL-D25 — Validated `pi-subagents` minimum, and what a normal commit is');
  assert.match(record, /From `0\.72\.0` pi-subagents takes `typebox` from pi rather than bundling it/);
});

// CONV-198-AC1-PI-TYPEBOX-FALLBACK-TEST-SKIPS: the positive path must not depend on the machine having pi installed.
// A temporary pi package carrying `typebox`, a temporary receiver whose schema imports it, and a child process whose
// PATH names only that pi: the helper must choose `pi`, the schema must load, and `typebox/value` must resolve.
test('Issue #197 a fixture pi package supplies typebox to a receiver that does not carry it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i197-fixture-'));
  const pi = path.join(root, 'pi-coding-agent'), typebox = path.join(pi, 'node_modules', 'typebox');
  fs.mkdirSync(typebox, { recursive: true });
  fs.writeFileSync(path.join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0' }));
  fs.writeFileSync(path.join(pi, 'cli.js'), '');
  fs.writeFileSync(path.join(typebox, 'package.json'), JSON.stringify({ name: 'typebox', version: '0.0.0', exports: { '.': './index.mjs', './value': './value.js' } }));
  fs.writeFileSync(path.join(typebox, 'index.mjs'), "export const Type = { Object: (properties) => ({ type: 'object', properties }) };\n");
  fs.writeFileSync(path.join(typebox, 'value.js'), 'module.exports = { Value: { Check: () => true } };\n');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(path.join(pi, 'cli.js'), path.join(bin, 'pi'));
  const receiver = path.join(root, 'receiver');
  fs.mkdirSync(path.join(receiver, 'src', 'extension'), { recursive: true });
  fs.writeFileSync(path.join(receiver, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: '0.73.1', type: 'module' }));
  fs.writeFileSync(path.join(receiver, 'src', 'extension', 'schemas.js'), "import { Type } from 'typebox';\nexport const SubagentParams = Type.Object({ agent: {} });\n");
  const script = `
    const path = require('node:path'); const { createRequire } = require('node:module'); const { pathToFileURL } = require('node:url');
    const { receiverTypebox } = require(${JSON.stringify(path.join(__dirname, 'helpers.js'))});
    const source = receiverTypebox(${JSON.stringify(receiver)});
    import(pathToFileURL(path.join(${JSON.stringify(receiver)}, 'src/extension/schemas.js')).href).then((schemas) => {
      const value = require(createRequire(path.join(source.root, 'package.json')).resolve('typebox/value'));
      process.stdout.write(JSON.stringify({ from: source.from, keys: Object.keys(schemas.SubagentParams.properties), check: typeof value.Value.Check }));
    }, (error) => { process.stdout.write(JSON.stringify({ error: error.message })); });`;
  const env = { ...process.env, PATH: bin }; delete env.PI_TIDD_NO_PI_TYPEBOX;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(child.stdout || '{}'), { from: 'pi', keys: ['agent'], check: 'function' }, child.stderr);
});

// ADV-198-PI-EXECUTABLE-WRAPPER: the `pi` on PATH may be a wrapper script or a Windows npm shim, not a symlink into the
// package. The installed package is then found under npm's global root instead (the prefix npm installs pi into).
test('Issue #197 a wrapper pi on PATH still finds the pi package under the npm global root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i197-wrapper-'));
  const prefix = path.join(root, 'prefix');
  const pi = path.join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'), typebox = path.join(pi, 'node_modules', 'typebox');
  fs.mkdirSync(typebox, { recursive: true });
  fs.writeFileSync(path.join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0' }));
  fs.writeFileSync(path.join(typebox, 'package.json'), JSON.stringify({ name: 'typebox', version: '0.0.0', exports: { '.': './index.mjs' } }));
  fs.writeFileSync(path.join(typebox, 'index.mjs'), 'export const Type = {};\n');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
  const receiver = path.join(root, 'receiver'); fs.mkdirSync(receiver);
  fs.writeFileSync(path.join(receiver, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: '0.73.1' }));
  const source = helpers.receiverTypebox(receiver, { pathEnv: bin, prefixes: [prefix] });
  assert.deepEqual(source, { from: 'pi', root: pi });
});

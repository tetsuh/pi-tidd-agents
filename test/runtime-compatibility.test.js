'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readText, repoPath, sectionOf } = require('./helpers');
const inspectRuntime = (input) => require('../scripts/compatibility').inspectRuntime(input);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidd-compatibility-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const piRoot = path.join(root, 'pi'), subagentsRoot = path.join(root, 'subagents');
  for (const [dir, name, version] of [[piRoot, '@earendil-works/pi-coding-agent', '1.6.1'], [subagentsRoot, 'pi-subagents', '0.90.0']]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return { piRoot, subagentsRoot, expectedPi: '1.6.1', expectedSubagents: '0.90.0' };
}

test('compatibility preflight reports actual versions and checks both optional pins', (t) => {
  const input = fixture(t);
  const report = { node: process.versions.node, pi: '1.6.1', subagents: '0.90.0' };
  assert.deepEqual(inspectRuntime(input), report);
  assert.deepEqual(inspectRuntime({ piRoot: input.piRoot, subagentsRoot: input.subagentsRoot }), report);
  assert.throws(() => inspectRuntime({ ...input, expectedPi: '1.6.0' }), /Pi version mismatch: expected 1\.6\.0, installed 1\.6\.1/);
  assert.throws(() => inspectRuntime({ ...input, expectedSubagents: '0.78.0' }), /pi-subagents version mismatch: expected 0\.78\.0, installed 0\.90\.0/);
});

test('compatibility preflight refuses missing runtimes rather than skipping', (t) => {
  const input = fixture(t);
  for (const key of ['piRoot', 'subagentsRoot']) {
    assert.throws(() => inspectRuntime({ ...input, [key]: path.join(input[key], 'missing') }), /cannot read .*package\.json/);
  }
});

test('compatibility preflight refuses malformed or unrelated runtime manifests', (t) => {
  const input = fixture(t);
  for (const [key, name] of [['piRoot', '@earendil-works/pi-coding-agent'], ['subagentsRoot', 'pi-subagents']]) {
    const file = path.join(input[key], 'package.json'), original = fs.readFileSync(file);
    for (const source of ['not json', 'null', '[]', JSON.stringify({ name: 'another-package', version: '1.6.1' }), JSON.stringify({ name }), JSON.stringify({ name, version: 90 }), JSON.stringify({ name, version: '' })]) {
      fs.writeFileSync(file, source);
      assert.throws(() => inspectRuntime(input), /cannot read|invalid runtime manifest/);
    }
    fs.writeFileSync(file, original);
  }
});

test('the compatibility command fails before running tests when runtimes are absent', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidd-no-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_prefix: home, NPM_CONFIG_PREFIX: home };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [repoPath('scripts/compatibility.js')], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /tidd-compatibility: cannot read .*package\.json/);
  assert.equal(child.stdout, '', 'no successful runtime report or skipped test run');
});

test('the compatibility command drives the existing runtime boundaries without adding package dependencies', () => {
  const { TEST_FILES } = require('../scripts/compatibility');
  assert.deepEqual(TEST_FILES, [
    'test/issue-152-writer-launch.test.js',
    'test/issue-159-gate-launch-cwd.test.js',
    'test/issue-197-typebox-from-pi.test.js',
    'test/issue-287-receiver-flat-schema.test.js',
    'test/package.test.js',
  ]);
  const pkg = JSON.parse(readText('package.json'));
  assert.equal(pkg.scripts['test:compat'], 'node scripts/compatibility.js');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('CI installs pinned runtimes before the mandatory compatibility command', () => {
  const workflow = readText('.github/workflows/test.yml');
  const job = workflow.split('\n  compatibility:\n')[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(job, 'a separate compatibility job exists');
  assert.match(job, /node-version: \[22, 24\]/);
  assert.match(job, /subagents-version: \['0\.70\.0', '0\.78\.0', '0\.90\.0'\]/);
  assert.match(job, /TIDD_EXPECT_PI_VERSION: '1\.6\.1'/);
  assert.ok(job.includes('TIDD_EXPECT_SUBAGENTS_VERSION: ${{ matrix.subagents-version }}'));
  const host = job.indexOf('npm install --global'), receiver = job.indexOf('npm install --prefix'), run = job.indexOf('npm run test:compat');
  assert.ok(host >= 0 && receiver > host && run > receiver, 'both installs precede the check');
  assert.ok(job.includes('"@earendil-works/pi-coding-agent@$TIDD_EXPECT_PI_VERSION"'));
  assert.ok(job.includes('"pi-subagents@$TIDD_EXPECT_SUBAGENTS_VERSION"'));
  assert.ok(job.includes('"$HOME/.pi/agent/npm"'));
  assert.doesNotMatch(job, /continue-on-error|\|\|\s*true/);
});

test('the README separates installed-runtime compatibility from live model execution', () => {
  const section = sectionOf(readText('README.md'), '### Runtime compatibility checks');
  assert.ok(section, 'the compatibility section exists');
  for (const text of ['0.70.0', '0.78.0', '0.90.0', '1.6.1', 'npm run test:compat', 'TIDD_EXPECT_PI_VERSION', 'TIDD_EXPECT_SUBAGENTS_VERSION', 'not live-model end-to-end tests']) {
    assert.ok(section.includes(text), `compatibility documentation names ${text}`);
  }
});

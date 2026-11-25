'use strict';

// Development-only: run the existing receiver tests against installed packages, never
// install or launch an agent. Unlike npm test, absence of either runtime is a failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILES = Object.freeze([
  'test/issue-152-writer-launch.test.js',
  'test/issue-159-gate-launch-cwd.test.js',
  'test/issue-197-typebox-from-pi.test.js',
  'test/issue-287-receiver-flat-schema.test.js',
  'test/package.test.js',
]);

function installedVersion(root, name) {
  const file = path.join(root, 'package.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read ${file}: ${error.message}`); }
  if (!manifest || manifest.name !== name || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`invalid runtime manifest ${file}: expected ${name} with a version`);
  }
  return manifest.version;
}

function inspectRuntime({ piRoot, subagentsRoot, expectedPi, expectedSubagents }) {
  const pi = installedVersion(piRoot, '@earendil-works/pi-coding-agent');
  const subagents = installedVersion(subagentsRoot, 'pi-subagents');
  for (const [name, expected, actual] of [['Pi', expectedPi, pi], ['pi-subagents', expectedSubagents, subagents]]) {
    if (expected !== undefined && expected !== actual) throw new Error(`${name} version mismatch: expected ${expected}, installed ${actual}`);
  }
  return { node: process.versions.node, pi, subagents };
}

function main() {
  try {
    // Match the discovery paths the receiver and package tests use, not a guessed
    // global prefix or a package resolved from this repository's node_modules.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = spawnSync(npm, ['root', '--global'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000 });
    if (root.error || root.status !== 0 || !root.stdout.trim()) throw new Error(`npm root --global failed: ${root.error?.message || root.stderr || root.signal || root.status}`);
    const report = inspectRuntime({
      piRoot: path.join(root.stdout.trim(), '@earendil-works', 'pi-coding-agent'),
      subagentsRoot: path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents'),
      expectedPi: process.env.TIDD_EXPECT_PI_VERSION,
      expectedSubagents: process.env.TIDD_EXPECT_SUBAGENTS_VERSION,
    });
    process.stdout.write(`Runtime compatibility: ${JSON.stringify(report)}\n`);
    const tests = spawnSync(process.execPath, ['--test', ...TEST_FILES], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    if (tests.error || tests.signal) throw new Error(`test process failed: ${tests.error?.message || tests.signal}`);
    process.exitCode = tests.status ?? 1;
  } catch (error) {
    process.stderr.write(`tidd-compatibility: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { inspectRuntime, TEST_FILES };

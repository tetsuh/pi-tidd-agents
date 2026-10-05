'use strict';

// Issue #238 (#234 part a): the tests read the clause manifest through one helper, so moving the clauses beside their
// records changes that helper rather than every test that reads them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { repoPath, readText, readManifest } = require('./helpers');

// The file's name is assembled, so this file names it on no line and is scanned like any other.
const NAME = ['contract', 'clauses'].join('-');
const MANIFEST = `test/${NAME}.json`;
// Every line of a script in the repository that names the manifest file, once each and compared after trimming, with why it stays: readManifest itself,
// two comments, and the readers that work on the file's text or on an in-memory overlay of it rather than its value,
// which #234 moves with the clauses (contract-record's text source; issue-110's scan list, manifestGaps overlay reader,
// overlay mutation and mutation case). Any other line naming the file fails, whatever it does with it: a reader goes
// through readManifest. A reader that reaches the file through a constant or a computed path, as this file does, is
// outside what a line scan can see; that bound is accepted.
const ALLOWED = [
  ["test/helpers.js", "function readManifest() { return readJson('test/@.json'); }"],
  ["test/closed-loop-regressions.test.js", "// Prose obligations belong in test/@.json, not here."],
  ["test/contract-record.test.js", "// implements, and test/@.json is how those decisions are enforced"],
  ["test/contract-record.test.js", "const manifestSource = readText('test/@.json');"],
  ["test/issue-110-derived-vocabulary.test.js", "for (const file of [...proseFiles(), 'test/@.json', 'test/issue-100-tidd-roles.test.js', 'test/issue-101-convergence-stage.test.js', 'test/issue-49-agent-tools.test.js', 'test/package.test.js', 'test/issue-100-gate-ids-v2.test.js']) {"],
  ["test/issue-110-derived-vocabulary.test.js", "const clauses = JSON.parse(read('test/@.json')).clauses.filter((clause) => ['CL-D59', 'CL-D60', 'CL-D62', 'CL-D63'].includes(clause.marker));"],
  ["test/issue-110-derived-vocabulary.test.js", "overlay.set('test/@.json', readText('test/@.json').replace('\"before each convergence/Sol/Terra invocation\"', '\"before each Sol/Terra invocation\"'));"],
  ["test/issue-110-derived-vocabulary.test.js", "['convergence dropped from a manifest literal', 'test/@.json', (text) => text.replace('\"before each convergence/Sol/Terra invocation\"', '\"before each Sol/Terra invocation\"'), manifestGaps, [`CL-D62-autofix-map literals: found ${['before each Sol/Terra invocation', MANIFEST['CL-D62-autofix-map'][1]].join(' ‖ ')}; declared ${MANIFEST['CL-D62-autofix-map'].join(' ‖ ')}`]],"],
].map(([file, line]) => [file, line.split('@').join(NAME)]);

// Every script in the repository, at any depth, that node --test can load (.js, .cjs, .mjs, .ts, .cts, .mts); Git's
// directory, installed modules and pi's runtime roots are not the repository's own.
function scripts(dir) {
  return fs.readdirSync(repoPath(dir), { withFileTypes: true }).filter((e) => !['.git', 'node_modules', '.pi', '.pi-subagents'].includes(e.name))
    .flatMap((e) => (e.isDirectory() ? scripts(path.posix.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.posix.join(dir, e.name)] : []));
}

test('Issue #238 no script names the clause manifest except the readers listed for #234', () => {
  const counts = ALLOWED.map(() => 0);
  for (const file of scripts('.')) {
    readText(file).split('\n').forEach((line, i) => {
      if (!line.includes(NAME)) return;
      const at = ALLOWED.findIndex(([f, text]) => f === file && line.trim() === text);
      assert.ok(at >= 0, `${file}:${i + 1} names the manifest; read it through readManifest(): ${line.trim()}`);
      counts[at] += 1;
    });
  }
  assert.deepEqual(counts, ALLOWED.map(() => 1), 'every listed line is there exactly once');
});

test('Issue #238 readManifest returns the manifest file\'s value', () => {
  // The independent oracle for AC2: the file's bytes parsed here, not through helpers.js.
  assert.deepEqual(readManifest(), JSON.parse(fs.readFileSync(repoPath(MANIFEST), 'utf8')));
  assert.ok(readManifest().clauses.length > 300);
});

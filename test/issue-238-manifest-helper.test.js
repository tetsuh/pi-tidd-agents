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
// Every line of a script in the repository that contains the former manifest file's name, once each and compared
// after trimming: since #234 removed the file, none. Any line that contains the name fails, whatever it does with it,
// and readJson refuses every clause source's file however its path is spelled, aliased or linked (below). Nothing else
// is claimed (AC1 of #238): a route that never asks readJson for a clause source's file and has the name on no scanned
// line is outside this pin.
const ALLOWED = [];

// Every script in the repository, at any depth, that node --test can load (.js, .cjs, .mjs, .ts, .cts, .mts); Git's
// directory, installed modules and pi's runtime roots at the root are not the repository's own.
function scripts(dir) {
  return fs.readdirSync(repoPath(dir), { withFileTypes: true }).filter((e) => dir !== '.' || !['.git', 'node_modules', '.pi', '.pi-subagents'].includes(e.name))
    .flatMap((e) => (e.isDirectory() ? scripts(path.posix.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.posix.join(dir, e.name)] : []));
}

test('Issue #238 no script line contains the clause manifest\'s name except the lines listed here', () => {
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

// Rounds 1 and 2 of PR #239 (CONV-239-AC1-COMPUTED-PATH-SCAN, CONV-239-AC1-COMPUTED-PATH-GUARD): no text scan can
// see every way a test reaches the pins, so readJson refuses a clause source's file (device and inode) at run time:
// by its path, by an alias of readJson, through a symbolic link, or through a hard link. Since #234 the sources are
// the clause files beside the records (CL-D105).
const SOURCE = 'contract/CL-D1.clauses.json';
test('Issue #238 readJson refuses a clause source by path, alias, symbolic link and hard link', () => {
  const helpers = require('./helpers');
  const { readJson: parseFile } = helpers;
  const refused = /read the clause manifest through readManifest\(\)/;
  assert.throws(() => parseFile(SOURCE), refused);
  assert.throws(() => helpers.readJson.call(null, `test/../${SOURCE}`), refused);
  const link = `test/.issue-238-link-${process.pid}.json`;
  fs.symlinkSync(path.relative('test', SOURCE), repoPath(link));
  try { assert.throws(() => parseFile(link), refused); } finally { fs.rmSync(repoPath(link), { force: true }); }
  const hard = `test/.issue-238-hard-${process.pid}.json`;
  fs.linkSync(repoPath(SOURCE), repoPath(hard));
  try { assert.throws(() => parseFile(hard), refused); } finally { fs.rmSync(repoPath(hard), { force: true }); }
  assert.equal(parseFile('package.json').name, JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8')).name, 'any other file still parses');
});

test('Issue #238 readManifest returns every clause source\'s clauses, in order', () => {
  // The independent oracle for #238 AC2 as CL-D105 reshapes it (#240 AC1): each source's bytes parsed here, not
  // through helpers.js, and their clauses concatenated.
  const { manifestSources } = require('./helpers');
  assert.equal(fs.existsSync(repoPath(MANIFEST)), false, 'the shared manifest is gone (#234)');
  assert.deepEqual(readManifest().clauses, manifestSources().flatMap((source) => JSON.parse(fs.readFileSync(repoPath(source), 'utf8')).clauses));
  assert.ok(readManifest().clauses.length > 300);
});

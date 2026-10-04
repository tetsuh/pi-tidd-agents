'use strict';

// Issue #215 (CL-D103): every contract record is its own file under `contract/`. CONTRACT.md keeps its preamble and
// lists the record files in order; the contract is the preamble followed by those files in that order, one blank line
// apart (`readContract()` in ./helpers). A pull request that changes one record then carries that record's file in
// its required evidence and no other record (CL-D69's set: the changed files plus CONTRACT.md and README.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readText, readJson, repoPath, readContract } = require('./helpers');

const INDEX_HEADING = '## Record index';
const ENTRY = /^- \[(contract\/([A-Za-z0-9._-]+)\.md)\]\(\1\) — (.+)$/;

function indexEntries() {
  const text = readText('CONTRACT.md');
  const at = text.indexOf(`\n${INDEX_HEADING}\n`);
  assert.notEqual(at, -1, `CONTRACT.md carries "${INDEX_HEADING}"`);
  return text.slice(at + INDEX_HEADING.length + 2).split('\n').filter((line) => line.startsWith('- ')).map((line) => {
    const m = ENTRY.exec(line);
    assert.ok(m, `an index line names one record file and its title: ${line}`);
    return { file: m[1], id: m[2], title: m[3] };
  });
}

test('Issue #215 every record is one file under contract/, listed once in the index, in assembly order', () => {
  const entries = indexEntries();
  assert.ok(entries.length > 100, `the index lists the records: ${entries.length}`);
  assert.equal(new Set(entries.map((e) => e.file)).size, entries.length, 'each record file is listed once');
  const onDisk = fs.readdirSync(repoPath('contract')).filter((f) => f.endsWith('.md')).map((f) => `contract/${f}`).sort();
  assert.deepEqual(onDisk, entries.map((e) => e.file).sort(), 'no record file is missing from the index and none is unlisted');
  for (const { file, id, title } of entries) {
    const text = readText(file);
    assert.equal(text.split('\n')[0], `## ${id} — ${title}`, `${file} opens with its own heading, which the index repeats`);
    assert.equal(text.split('\n').filter((line) => line.startsWith('## ')).length, 1, `${file} holds one record`);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${file} ends in one newline and no blank line`);
  }
});

test('Issue #215 CONTRACT.md is the preamble and the index, and the assembly is the contract', () => {
  const index = readText('CONTRACT.md');
  assert.deepEqual(index.split('\n').filter((line) => line.startsWith('## ')), [INDEX_HEADING], 'CONTRACT.md holds no record of its own');
  assert.match(index, /^# Closed-loop workflow contract\n/);
  const contract = readContract();
  const preamble = index.slice(0, index.indexOf(`\n${INDEX_HEADING}\n`));
  assert.ok(contract.startsWith(preamble), 'the assembly starts with the preamble');
  const headings = contract.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(headings, indexEntries().map(({ id, title }) => `## ${id} — ${title}`), 'the assembly holds every record, in index order');
  assert.ok(!contract.split('\n').includes(INDEX_HEADING), 'and not the index heading');
  assert.match(contract, /\n---\n\n## /, 'one blank line after the preamble rule');
  assert.doesNotMatch(contract, /\n\n\n/, 'one blank line between records, never two');
});

test('Issue #215 the record files are development records, outside the package payload', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.files.some((entry) => entry === 'contract' || entry.startsWith('contract/')), false);
  assert.equal(path.basename(path.dirname(repoPath('contract/x.md'))), 'contract');
});

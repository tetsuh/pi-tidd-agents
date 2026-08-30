'use strict';

// Issue #58: the authority files are read per run and their CL-D2 payload blocks are
// retransmitted verbatim on every gate invocation, so a sentence duplicated between the two
// workflow roots is paid for twice. Shared policy belongs in the shared references that both
// roots already load. Compile/contract coverage over the shipped prose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, AUTHORITY_FILES } = require('./helpers');

const MIN_SENTENCE = 70;

// The scan has no exemption list. CL-D2's verbatim payload blocks paraphrase the sections
// they mirror rather than copying them sentence for sentence, so exempting them would hide
// nothing today while permanently blinding the guard over the largest prose regions — and the
// per-root role-authority blocks must reach their own gate verbatim, never match each other.
// If a future block does copy a sentence outright, this guard reports it and the exemption
// question comes back to a human with the evidence attached.
function sentences(file) {
  return readText(file)
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.split(/\s+/).join(' ').trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE);
}

test('Issue #58 no authority sentence is duplicated within or across the authority files', () => {
  const seen = new Map();
  for (const file of AUTHORITY_FILES) {
    for (const sentence of sentences(file)) {
      if (!seen.has(sentence)) seen.set(sentence, []);
      seen.get(sentence).push(file);
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sentence, files]) => `${Buffer.byteLength(sentence)}B in ${files.join(', ')}: ${sentence.slice(0, 90)}`);
  assert.deepEqual(duplicates, [], `authority prose is duplicated:\n${duplicates.join('\n')}`);
});

test('Issue #58 the guard measures exactly the files the byte guard measures', () => {
  // Both guards import one constant, so the lists cannot drift. Assert the byte guard really
  // consumes it rather than keeping a private copy that could silently stop measuring a file.
  const packageTest = readText('test/package.test.js');
  assert.match(packageTest, /AUTHORITY_FILES \} = require\('\.\/helpers'\)/, 'the byte guard must import the shared authority list');
  assert.doesNotMatch(packageTest, /const AUTHORITY_FILES = \[/, 'the byte guard must not redeclare the authority list');
  assert.match(packageTest, /AUTHORITY_FILES\.reduce/, 'the byte guard must measure the shared list');
  assert.equal(AUTHORITY_FILES.length, 7);
  for (const file of AUTHORITY_FILES) assert.ok(readText(file).length > 0, `${file} must exist`);
});

test('Issue #58 the scan sees the payload blocks it deliberately does not exempt', () => {
  // Guard against the scan silently skipping a region: every CL-D2 block heading must fall
  // inside the scanned text, so a verbatim copy inside one would be reported rather than lost.
  const blocks = [
    '#### Every-gate invariant payload block (CL-D2)',
    '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)',
    '### Issue gate role-authority blocks (CL-D2)',
    '### PR gate role-authority blocks (CL-D2)',
  ];
  for (const heading of blocks) {
    const owner = AUTHORITY_FILES.find((file) => readText(file).includes(heading));
    assert.ok(owner, `payload block heading is absent from every authority file: ${heading}`);
    const scanned = sentences(owner).join('\n');
    const body = readText(owner).replace(/\r\n/g, '\n').split(heading)[1].split(/\n#{1,4} /)[0];
    const first = body.split(/(?<=[.!?])\s+/).map((x) => x.split(/\s+/).join(' ').trim()).find((x) => x.length >= MIN_SENTENCE);
    assert.ok(first, `${heading} has no scannable sentence`);
    assert.ok(scanned.includes(first), `${heading} content is outside the scan`);
  }
});

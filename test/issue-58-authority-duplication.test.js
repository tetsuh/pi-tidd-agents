'use strict';

// Issue #58: the six authority files are read per run and their CL-D2 payload blocks are
// retransmitted verbatim on every gate invocation, so a sentence duplicated between the two
// workflow roots is paid for twice. Shared policy belongs in the shared references that both
// roots already load. Compile/contract coverage over the shipped prose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText } = require('./helpers');

// Deliberately the same list the byte guard in test/package.test.js measures, so the two
// cannot drift apart.
const AUTHORITY_FILES = [
  'skills/closed-loop-issue/SKILL.md',
  'skills/closed-loop-pr/SKILL.md',
  'skills/closed-loop-pr/references/review-only.md',
  'skills/closed-loop-pr/references/autofix.md',
  'skills/closed-loop-shared/references/gate-contract.md',
  'skills/closed-loop-shared/references/records.md',
];

// CL-D2 requires the every-gate and Sol-only blocks to be transmitted verbatim, so their
// overlap with the sections they mirror is deliberate and is not duplication.
const VERBATIM_BLOCKS = [
  '#### Every-gate invariant payload block (CL-D2)',
  '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)',
  '### Issue gate role-authority blocks (CL-D2)',
  '### PR gate role-authority blocks (CL-D2)',
];
const MIN_SENTENCE = 70;

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

function sentencesOutsideVerbatimBlocks(file) {
  let text = readText(file);
  for (const heading of VERBATIM_BLOCKS) {
    const section = sectionOf(text, heading);
    if (section) text = text.split(section).join('\n');
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.split(/\s+/).join(' ').trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE);
}

test('Issue #58 no authority sentence is duplicated across the six files', () => {
  const seen = new Map();
  for (const file of AUTHORITY_FILES) {
    for (const sentence of sentencesOutsideVerbatimBlocks(file)) {
      if (!seen.has(sentence)) seen.set(sentence, []);
      seen.get(sentence).push(file);
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sentence, files]) => `${Buffer.byteLength(sentence)}B in ${files.join(', ')}: ${sentence.slice(0, 90)}`);
  assert.deepEqual(duplicates, [], `authority prose is duplicated:\n${duplicates.join('\n')}`);
});

test('Issue #58 the guard covers the same files the byte guard measures', () => {
  // If the byte guard's list changes, this list must change with it.
  const packageTest = readText('test/package.test.js');
  for (const file of AUTHORITY_FILES) {
    const constant = file.split('/').pop().replace('.md', '');
    assert.ok(packageTest.includes(constant), `${file} must remain part of the measured authority set (${constant})`);
  }
  assert.equal(AUTHORITY_FILES.length, 6);
});

test('Issue #58 the verbatim payload blocks still exist and are still exempt', () => {
  // The exemption must not silently become dead weight that hides real duplication.
  const found = VERBATIM_BLOCKS.filter((heading) => AUTHORITY_FILES.some((file) => sectionOf(readText(file), heading)));
  assert.deepEqual(found.slice().sort(), VERBATIM_BLOCKS.slice().sort(), 'every exempt block heading must exist in an authority file');
});

'use strict';

// Issue #215 (CL-D103): every contract record is its own file under `contract/`. CONTRACT.md keeps its preamble and
// lists the record files in order; the contract is the preamble followed by those files in that order, one blank line
// apart (`readContract()` in ./helpers). A pull request that changes one record then carries that record's file in
// its required evidence and no other record (CL-D72's set: the changed files plus CONTRACT.md and README.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const helpersModule = require('./helpers');
const { readJson, repoPath } = helpersModule;
// Round 3 of PR #233 (ADV-233-SPLIT-CRLF): a Windows checkout carries CRLF line ends. The structural checks read every
// text with LF line ends, so they hold on either checkout; `readContract()` itself keeps the line end it found.
const lf = (text) => text.replace(/\r\n/g, '\n');
const readText = (file) => lf(helpersModule.readText(file));
const readContract = () => lf(helpersModule.readContract());
const helpers = require('../skills/closed-loop-pr/helpers');

const INDEX_HEADING = '## Record index';
const ENTRY = /^- \[(contract\/([A-Za-z0-9._-]+)\.md)\]\(\1\) — (.+)$/;

const INDEX_NOTE = 'Each record is its own file under `contract/`, listed here in order. The contract is this preamble followed by every record file in this order, one blank line apart (CL-D103).';

// Round 2 of PR #233 (CONV-233-INDEX-STRUCTURE-COVERAGE): after the index heading every line is blank, the one note,
// or a record entry whose title is its record's heading, so no status column, table or other text joins the index.
function indexProblems(text) {
  const at = text.indexOf(`\n${INDEX_HEADING}\n`);
  if (at === -1) return [`CONTRACT.md carries no "${INDEX_HEADING}"`];
  const heading = (file) => { try { return readText(file).split('\n')[0]; } catch { return null; } };
  return text.slice(at + INDEX_HEADING.length + 2).split('\n').filter((line) => {
    if (line === '' || line === INDEX_NOTE) return false;
    const m = ENTRY.exec(line);
    return !m || heading(m[1]) !== `## ${m[2]} — ${m[3]}`;
  }).map((line) => `not a record entry with its record's title: ${line}`);
}
function indexEntries() {
  const text = readText('CONTRACT.md');
  assert.deepEqual(indexProblems(text), [], 'the index holds only the note and record entries');
  return text.slice(text.indexOf(`\n${INDEX_HEADING}\n`)).split('\n').filter((line) => ENTRY.test(line)).map((line) => {
    const m = ENTRY.exec(line);
    return { file: m[1], id: m[2], title: m[3] };
  });
}
// Round 2 of PR #233 (CONV-233-RECORD-FILE-MODE): a record file is a regular file, never a link, since
// `required_evidence_set` carries only regular files and a linked record would drop out of a gate's evidence.
function recordFileProblem(absolute) {
  const stat = fs.lstatSync(absolute);
  return stat.isFile() ? null : `${absolute} is not a regular file`;
}

test('Issue #215 every record is one file under contract/, listed once in the index, in assembly order', () => {
  const entries = indexEntries();
  assert.ok(entries.length > 100, `the index lists the records: ${entries.length}`);
  assert.equal(new Set(entries.map((e) => e.file)).size, entries.length, 'each record file is listed once');
  const onDisk = fs.readdirSync(repoPath('contract')).filter((f) => f.endsWith('.md')).map((f) => `contract/${f}`).sort();
  assert.deepEqual(onDisk, entries.map((e) => e.file).sort(), 'no record file is missing from the index and none is unlisted');
  for (const { file, id, title } of entries) {
    assert.equal(path.basename(file, '.md'), id, `${file} is named by its record's ID`);
    assert.equal(recordFileProblem(repoPath(file)), null);
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
});

// AC5 of #215 (CONV-233-AC5-SIZE-HISTORY): a record states a principle, and the fix history of a change stays in its
// pull request's timeline and commits. A record is at most RECORD_LIMIT bytes. A record over it when CL-D103 was
// adopted (CL-D72 measured with its forward note to CL-D103) may grow by EXEMPT_ROOM and no further while it stays
// over the limit, so the next forward note to one of them does not force a trim.
const RECORD_LIMIT = 8000, EXEMPT_ROOM = 1024;
// #235 L1 brought CL-D36 and CL-D96 under the limit, so their exemptions ended; an exemption lasts only while its record
// is still over the limit.
const EXEMPT = { 'contract/CL-D93.md': 14396, 'contract/CL-D72.md': 10417 };

test('Issue #215 every record is at most 8,000 bytes, and the four larger at the split stay within their ceiling', () => {
  const files = fs.readdirSync(repoPath('contract')).filter((f) => f.endsWith('.md')).map((f) => `contract/${f}`);
  assert.ok(files.length > 100, 'the records are there to measure');
  for (const file of files) {
    const size = fs.statSync(repoPath(file)).size, ceiling = file in EXEMPT ? EXEMPT[file] + EXEMPT_ROOM : RECORD_LIMIT;
    assert.ok(size <= ceiling, `${file} is ${size} bytes, over its ceiling of ${ceiling}; keep fix history in the pull request (CL-D103)`);
  }
  for (const [file, size] of Object.entries(EXEMPT)) assert.ok(size > RECORD_LIMIT && files.includes(file) && fs.statSync(repoPath(file)).size > RECORD_LIMIT, `${file} is an exemption only while it exists and is over the limit`);
});

// AC3 and AC4 of #215: a pull request that changes one record carries that record's file and no other; the set follows
// from the diff, so nothing the writer or the parent supplies narrows it.
test('Issue #215 a change to one record puts that record, CONTRACT.md and README.md in the required evidence, and no other record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-215-evidence-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Issue 215 Test']); git(['config', 'user.email', 'issue215@example.invalid']);
    write('CONTRACT.md', '# Contract\n\n## Record index\n\n- [contract/CL-D1.md](contract/CL-D1.md) — one\n- [contract/CL-D2.md](contract/CL-D2.md) — two\n');
    write('README.md', 'readme\n'); write('contract/CL-D1.md', '## CL-D1 — one\n'); write('contract/CL-D2.md', '## CL-D2 — two\n');
    git(['add', '.']); git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    write('contract/CL-D2.md', '## CL-D2 — two\n\nChanged.\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'head']);
    const head = git(['rev-parse', 'HEAD']);
    const set = helpers.requiredEvidenceSet({ cwd: root, baseOid: base, headOid: head, identities: [] });
    assert.equal(set.ok, true, JSON.stringify(set.error));
    const blob = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.deepEqual(set.data.requiredEvidence, ['CONTRACT.md', 'README.md', 'contract/CL-D2.md'].map((source) => ({ source, kind: 'file', identity: blob(source) })));
    assert.deepEqual(set.data.authority, { included: ['CONTRACT.md', 'README.md'], absent: [], excluded: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #215 the index refuses any line but the note and record entries, and a record file must be a regular file', () => {
  const index = readText('CONTRACT.md');
  assert.deepEqual(indexProblems(index), []);
  for (const [label, extra] of [['a table row', '| CL-D1 | active |'], ['a status after an entry', '- [contract/CL-D1.md](contract/CL-D1.md) — Gate verdicts are supplied by the caller, not by agent files | active'], ['a sub-heading', '### Superseded'], ['a loose sentence', 'Superseded records follow.']]) {
    assert.equal(indexProblems(`${index}${extra}\n`).length, 1, `${label} is refused`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-215-mode-'));
  try {
    fs.writeFileSync(path.join(dir, 'real.md'), '## CL-D1 — one\n');
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'CL-D1.md'));
    assert.equal(recordFileProblem(path.join(dir, 'real.md')), null);
    assert.match(recordFileProblem(path.join(dir, 'CL-D1.md')), /not a regular file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

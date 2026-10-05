'use strict';

// Issue #240 (#234 part b1, CL-D105): a record's clause pins live beside it in contract/<id>.clauses.json, and the tests
// read every source through one assembly: the residual manifest while it exists, then each indexed record's clause file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const prHelpers = require('../skills/closed-loop-pr/helpers');
const { repoPath, readText, readContract, contractIndex, manifestSources, readManifest } = require('./helpers');

const RESIDUAL = `test/${['contract', 'clauses'].join('-')}.json`;
const clauseFile = (record) => record.replace(/\.md$/, '.clauses.json');
const clausesLine = (record) => {
  const line = /^\*\*Clauses:\*\* (.+)$/m.exec(readText(record));
  return line && !line[1].startsWith('none') ? line[1].split(',').map((id) => id.trim()) : [];
};
const overlay = (changes) => (file) => (file in changes ? changes[file] : readText(file));

test('Issue #240 contract/ holds only indexed records and their clause files, each a regular file', () => {
  const indexed = new Set(contractIndex().files);
  for (const name of fs.readdirSync(repoPath('contract'))) {
    const file = `contract/${name}`;
    const record = file.endsWith('.clauses.json') ? file.replace(/\.clauses\.json$/, '.md') : file;
    assert.ok(indexed.has(record), `${file} belongs to no indexed record`);
    assert.ok(fs.lstatSync(repoPath(file)).isFile(), `${file} is a regular file`);
  }
  assert.ok(fs.existsSync(repoPath('contract/CL-D105.clauses.json')), 'CL-D105 keeps its clauses beside it');
});

test('Issue #240 a clause file holds exactly its record\'s Clauses line, and a structural record has none', () => {
  for (const record of contractIndex().files) {
    const file = clauseFile(record), ids = clausesLine(record);
    if (!fs.existsSync(repoPath(file))) continue;
    assert.ok(ids.length > 0, `${record} is structural and has no clause file`);
    const value = JSON.parse(fs.readFileSync(repoPath(file), 'utf8'));
    assert.deepEqual(Object.keys(value), ['clauses'], `${file} holds only its clauses`);
    assert.deepEqual(value.clauses.map((c) => c.id).sort(), [...ids].sort(), `${file} holds exactly the ids ${record} lists`);
  }
});

test('Issue #240 readManifest concatenates every clause file in index order', () => {
  const sources = manifestSources();
  // Since #234 the shared manifest is gone and every source is a record's clause file.
  assert.equal(fs.existsSync(repoPath(RESIDUAL)), false, 'the shared manifest is gone');
  assert.deepEqual(sources, contractIndex().files.map(clauseFile).filter((f) => fs.existsSync(repoPath(f))));
  // The order across every indexed record, with each file present.
  assert.deepEqual(manifestSources(() => true), contractIndex().files.map(clauseFile));
  const expected = sources.flatMap((source) => JSON.parse(fs.readFileSync(repoPath(source), 'utf8')).clauses);
  assert.deepEqual(readManifest().clauses, expected);
  // Every id a record lists is assembled once.
  const listed = contractIndex().files.flatMap(clausesLine).sort();
  assert.deepEqual(readManifest().clauses.map((c) => c.id).sort(), listed);
});

test('Issue #240 readJson refuses a clause file by path, alias, symbolic link and hard link', () => {
  const helpers = require('./helpers');
  const { readJson: parseFile } = helpers;
  const refused = /read the clause manifest through readManifest\(\)/, own = 'contract/CL-D105.clauses.json';
  assert.throws(() => parseFile(own), refused);
  assert.throws(() => helpers.readJson.call(null, 'contract/../contract/CL-D105.clauses.json'), refused);
  // Links go under test/, so a run that dies midway leaves nothing in contract/ for the layout check to trip on.
  const link = `test/.issue-240-link-${process.pid}.json`, hard = `test/.issue-240-hard-${process.pid}.json`;
  fs.symlinkSync(path.relative(path.dirname(repoPath(link)), repoPath(own)), repoPath(link));
  try { assert.throws(() => parseFile(link), refused); } finally { fs.rmSync(repoPath(link), { force: true }); }
  fs.linkSync(repoPath(own), repoPath(hard));
  try { assert.throws(() => parseFile(hard), refused); } finally { fs.rmSync(repoPath(hard), { force: true }); }
});

test('Issue #240 a clause in two sources, a duplicate key, or a clause file of another shape fails', () => {
  const own = JSON.parse(fs.readFileSync(repoPath('contract/CL-D105.clauses.json'), 'utf8'));
  const other = JSON.parse(fs.readFileSync(repoPath('contract/CL-D1.clauses.json'), 'utf8'));
  const twice = JSON.stringify({ clauses: [...other.clauses, own.clauses[0]] });
  assert.throws(() => readManifest(overlay({ 'contract/CL-D1.clauses.json': twice })), new RegExp(`${own.clauses[0].id} is in two sources`));
  assert.throws(() => readManifest(overlay({ 'contract/CL-D105.clauses.json': JSON.stringify({ clauses: [...own.clauses, own.clauses[0]] }) })), new RegExp(`${own.clauses[0].id} is listed twice in contract/CL-D105\\.clauses\\.json`));
  const source = readText('contract/CL-D105.clauses.json');
  assert.throws(() => readManifest(overlay({ 'contract/CL-D105.clauses.json': source.replace('"id": "CL-D105-record"', '"id": "CL-D105-record", "id": "shadow"') })), /duplicate JSON object key: id/);
  for (const shape of ['{"clauses": []}', '{"clauses": {}}', JSON.stringify({ ...own, extra: 1 }), '[]']) {
    assert.throws(() => readManifest(overlay({ 'contract/CL-D105.clauses.json': shape })), /contract\/CL-D105\.clauses\.json must hold exactly \{"clauses": \[\.\.\.\]\}/, shape);
  }
});

// AC3 (#234 AC2): a change to one record and its clause file carries those two, CONTRACT.md and README.md, and nothing else.
test('Issue #240 a change to a record and its clause file puts those two, CONTRACT.md and README.md in the evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-240-evidence-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Issue 240 Test']); git(['config', 'user.email', 'issue240@example.invalid']);
    write('CONTRACT.md', '# Contract\n\n## Record index\n\n- [contract/CL-D1.md](contract/CL-D1.md) — one\n- [contract/CL-D2.md](contract/CL-D2.md) — two\n');
    write('README.md', 'readme\n');
    for (const n of [1, 2]) { write(`contract/CL-D${n}.md`, `## CL-D${n} — x\n**Clauses:** CL-D${n}-a\n`); write(`contract/CL-D${n}.clauses.json`, `{"clauses": [{"id": "CL-D${n}-a", "files": ["README.md"], "requires": ["readme"]}]}\n`); }
    git(['add', '.']); git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    write('contract/CL-D2.md', '## CL-D2 — x\n**Clauses:** CL-D2-a\n\nChanged.\n');
    write('contract/CL-D2.clauses.json', '{"clauses": [{"id": "CL-D2-a", "files": ["README.md"], "requires": ["read"]}]}\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'head']);
    const set = prHelpers.requiredEvidenceSet({ cwd: root, baseOid: base, headOid: git(['rev-parse', 'HEAD']), identities: [] });
    assert.equal(set.ok, true, JSON.stringify(set.error));
    const blob = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.deepEqual(set.data.requiredEvidence, ['CONTRACT.md', 'README.md', 'contract/CL-D2.clauses.json', 'contract/CL-D2.md'].map((source) => ({ source, kind: 'file', identity: blob(source) })));
    assert.deepEqual(set.data.authority, { included: ['CONTRACT.md', 'README.md'], absent: [], excluded: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #240 CONTRACT.md and CL-D105 say where clause pins live', () => {
  assert.match(readText('CONTRACT.md'), /Each record's clause pins live beside it in `contract\/<id>\.clauses\.json`/);
  assert.match(readContract(), /## CL-D105 — /);
  assert.match(readText('contract/CL-D103.md'), /CL-D105 later put each record's clause pins beside it, in `contract\/<id>\.clauses\.json`\./);
});

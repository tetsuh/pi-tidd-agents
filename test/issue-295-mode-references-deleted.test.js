'use strict';

// Issue #295 (#249 C2, CL-D119): the prose path is gone. The PR Skill keeps only what the parent and the gate launch read,
// the four mode references are deleted, both drivers hash the PR Skill and the two shared references alone, the two guards
// that measured the deleted files retire, and the authority ceiling falls on this change's measurement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { repoPath, readText, readContract, sectionOf, AUTHORITY_FILES } = require('./helpers');

const SKILL = 'skills/closed-loop-pr/SKILL.md';
const DELETED = ['review-only.md', 'autofix.md', 'autofix-addendum.md', 'helper-map.md'].map((file) => `skills/closed-loop-pr/references/${file}`);
const KEPT_HEADINGS = ['# Closed-loop pull-request readiness', '## Shared references (Issue #24)', '## Precondition guard (CL-D20)', '## Mode parsing (CL-D6)', '## Preflight (CL-D22, CL-D5)', '## Workflow target-kind boundary (CL-D7, CL-D8)', '## Driver dispatch (CL-D104)', '## PR gate payload composition (CL-D2, CL-D29)', '### PR gate role-authority blocks (CL-D2)'];
const CONTRACT_INPUT = "const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];";
// Every test file that still names a deleted file, and why: an absence check, a negative scan, or history in a comment.
const NAMERS = {
  'issue-110-derived-vocabulary': 'comments on what the deletion moved',
  'issue-159-gate-launch-cwd': 'its header comment names the history',
  'issue-164-map-split': 'no clause pins either file',
  'issue-87-addendum-split': 'its header comment names the history',
  'issue-249-prose-path-refused': 'negative routing scans',
  'issue-270-helper-map-pins': 'B1 inventory: the map is gone',
  'issue-272-review-only-pins': 'B2 inventory: the file is gone',
  'issue-277-autofix-pins': 'B3 inventory: the file is gone',
  'issue-284-addendum-d30-pins': 'B4a inventory: the file is gone',
  'issue-289-addendum-rest-pins': 'B4b inventory: the file is gone',
  'issue-293-stranded-rules': 'C1: the files are gone',
  'issue-295-mode-references-deleted': 'this test',
  package: 'the package ships none of them',
};
const CL_D119_BASELINE_BYTES = 74363; // the four authority files, measured on this change

// The role-block reader of the installed package's own launch.js, compiled with a probe export.
function roleBlockReader() {
  const file = repoPath('skills/closed-loop-pr/helpers/launch.js');
  const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__probe = { roleBlockLine, ROLE_BLOCKS };`, file);
  return m.exports.__probe;
}

test('Issue #295 the PR Skill keeps only its dispatch sections, and the gate launch still reads its role block', () => {
  const skill = readText(SKILL);
  assert.deepEqual(skill.split('\n').filter((line) => /^#{1,6} /.test(line)), KEPT_HEADINGS);
  assert.ok(skill.endsWith('\n') && !skill.endsWith('\n\n'), 'one final newline');
  assert.match(skill, /The other sections of this Skill and the shared references are the specification the driver and the gates implement; you read no mode reference, compose no helper request, and judge no finding\./);
  const { roleBlockLine, ROLE_BLOCKS } = roleBlockReader();
  for (const [nickname, role] of [['Sol', 'You are the read-only PR requirements, contract, scope, correctness, and test reviewer.'], ['Terra', 'You are the read-only concurrency, lifetime, ownership, cleanup, and decision-drift reviewer for this PR.']]) {
    const { line } = roleBlockLine(ROLE_BLOCKS.pr, nickname);
    assert.equal(line, `- \`PR ${nickname} role-authority block\`: \`${role}\``, `the ${nickname} line is byte-identical`);
  }
  assert.equal(sectionOf(skill, '### PR gate role-authority blocks (CL-D2)').includes('mode reference'), false, 'the block names no deleted file');
});

test('Issue #295 the four mode references are deleted, unhashed, unmeasured and unpacked, and every test that names one is listed', () => {
  for (const file of DELETED) assert.equal(fs.existsSync(repoPath(file)), false, `${file} is deleted`);
  for (const driver of ['review', 'autofix']) assert.ok(readText(`skills/closed-loop-pr/driver/${driver}.js`).includes(CONTRACT_INPUT), `${driver}.js hashes the PR Skill and the two shared references alone`);
  assert.deepEqual(AUTHORITY_FILES, ['skills/closed-loop-issue/SKILL.md', SKILL, 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md']);
  assert.equal(readText('test/helpers.js').includes('readAutofixProcedure'), false, 'no helper reads the deleted files');
  assert.equal(fs.existsSync(repoPath('test/issue-55-helper-invocation-map.test.js')), false, 'the map-to-CLI check retired with the map');
  assert.match(readText('test/issue-59-helper-surface.test.js'), /test\('Issue #59 the CLI operation table is frozen: every operation and its required fields \(#249, CL-D119\)'/);
  // Every JavaScript file under test/, at any depth, and any spelling of a deleted file's name.
  const named = /(?<![\w-])(?:review-only|autofix|autofix-addendum|helper-map)\.md|autofix-addendum|helper-map/;
  const namers = fs.readdirSync(repoPath('test'), { recursive: true }).filter((f) => /\.(?:c|m)?js$/.test(f) && named.test(readText(`test/${f}`))).map((f) => f.replace(/(\.test)?\.(?:c|m)?js$/, ''));
  assert.deepEqual(namers.sort(), Object.keys(NAMERS).sort());
  for (const dir of ['skills', 'agents', 'prompts']) {
    for (const file of fs.readdirSync(repoPath(dir), { recursive: true }).filter((f) => /\.(md|js|json|sh)$/.test(f))) assert.doesNotMatch(readText(`${dir}/${file}`), /references\/(?:review-only|autofix|autofix-addendum|helper-map)\.md/, `${dir}/${file}`);
  }
});

test("Issue #295 the guards retire with their files and the ceiling falls on this change's measurement", () => {
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 81000, `authority files total ${total}`);
  assert.ok(CL_D119_BASELINE_BYTES < 81000 && 81000 - CL_D119_BASELINE_BYTES > 6000, `the lowering left ${81000 - CL_D119_BASELINE_BYTES} bytes`);
  for (const file of ['test/package.test.js', 'test/issue-73-authority-budget.test.js', 'test/issue-87-authority-floor.test.js', 'test/issue-100-gate-ids-v2.test.js', 'test/issue-126-sol-component-sweep.test.js', 'test/issue-153-wording-only-minors.test.js']) {
    assert.match(readText(file), /total < 81000/, `${file} asserts the lowered ceiling`);
    assert.equal(readText(file).includes('total < 162000'), false, `${file}: the superseded ceiling must not survive`);
  }
  assert.equal(readText('test/package.test.js').includes('PR_SKILL_PRE_SPLIT_BYTES'), false, 'the disclosure guard retired');
  for (const file of fs.readdirSync(repoPath('test')).filter((f) => f.endsWith('.test.js'))) assert.equal(/^\s*assert\.ok\(Buffer\.byteLength\(addendum\)[^\n]*< 32000/m.test(readText(`test/${file}`)), false, `${file} still asserts the addendum guard`);
});

test('Issue #295 CL-D119 records the change and every touched record carries its note', () => {
  const record = sectionOf(readContract(), '## CL-D119 — The PR Skill is trimmed to its dispatch and the four mode references are deleted');
  assert.ok(record, 'CL-D119 is in the contract');
  assert.match(record, /tetsuh\/pi-tidd-agents#295/);
  assert.match(record, /The four authority files measured 74,363 bytes on this change, so the ceiling falls to 81,000 bytes on the CL-D43 terms, leaving 6,637 bytes\./);
  assert.match(readText('contract/CL-D38.md'), /a stop names the changed entries, where the definition observed presence only \(#249, CL-D119\); CL-D129 later closed it/);
  assert.match(readText('contract/AC-DECISION.md'), /its own pauses on dangerous operations and ship decisions lapsed with the prose path/);
  assert.match(readText('contract/AC-DISPOSITION.md'), /owner approval for merging without required deterministic coverage lapsed with the prose path/);
  assert.equal(readText('contract/CL-D96.md').includes('as autofix.md states it'), false, 'CL-D96 drops its pointer instead of taking a note');
  for (const file of JSON.parse(readText('contract/CL-D119.clauses.json')).clauses.find((clause) => clause.id === 'CL-D119-notes').files) {
    assert.ok(readText(file).includes('(CL-D119)'), `${file} carries the note`);
    assert.ok(Buffer.byteLength(readText(file)) < (file === 'contract/CL-D93.md' ? 15420 : 8000), `${file} stays under its limit`);
  }
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D119.md') !== -1 && index.indexOf('contract/CL-D119.md') < index.indexOf('contract/CL-D118.md'), 'CL-D119 is indexed above CL-D118');
});

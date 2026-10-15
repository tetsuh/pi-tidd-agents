'use strict';

// Issue #293 (#249 C1, CL-D118): before C2 deletes the four mode references, every rule only they state gets a home or
// retires. CL-D44 states the two sentences only the map stated; the map's no-shell instruction retires with the prose
// path, the kept dispatch section saying the parent composes no helper request; three sentences CL-D112 retired stop being
// asserted through the file. No code changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { repoPath, readText, readContract, sectionOf, cliSchemas } = require('./helpers');

const REFERENCES = {
  'skills/closed-loop-pr/references/review-only.md': '1fdb9c43551eb0aa2c829e70ba738e3e9440a6f7635017b353d1c33983ecb397',
  'skills/closed-loop-pr/references/autofix.md': 'b29a83ca9f411af5110c26234063cd7b2f15900b489fff380dfe4bb3cd382783',
  'skills/closed-loop-pr/references/autofix-addendum.md': 'bc7420e709b490745f1d4fa6dd9423a78539314c88f9f7d73929f9a5c7c09803',
  'skills/closed-loop-pr/references/helper-map.md': 'da1528b9cfadca6e6b375f118364e8d06c3566cb1d9d4f301d13f820ea78f357',
};
const NO_SHELL = 'Do not regenerate this logic as run-time shell';

test('Issue #293 the stranded rules have a home in the records or the code, and their tests read it there', () => {
  const d44 = readText('contract/CL-D44.md');
  assert.ok(d44.includes('never as a later identity, capture, or evidence failure that points at the target instead of the request'), 'CL-D44 states the late-failure clause');
  assert.ok(d44.includes('it is not a validator of producer output (#249, CL-D118)'), 'CL-D44 states the separator-not-validator clause');
  assert.equal(readText('test/issue-74-composition-shapes.test.js').includes("sectionOf(AUTOFIX, '### Cross-operation input shapes (CL-D44)')"), false, 'issue-74 no longer reads CL-D44 from the map');
  // The no-shell instruction retires: its readers read the dispatch rule and the CLI table instead.
  assert.match(readText('skills/closed-loop-pr/SKILL.md'), /you read no mode reference, compose no helper request, and judge no finding/);
  assert.equal(Object.keys(cliSchemas()).some((name) => /shell|jq|python|graphql/i.test(name)), false, 'the CLI offers no shell operation');
  // No test asserts the instruction any more.
  const asserting = fs.readdirSync(repoPath('test')).filter((f) => f.endsWith('.js') && f !== 'issue-293-stranded-rules.test.js' && readText(`test/${f}`).includes(NO_SHELL));
  assert.deepEqual(asserting, [], 'no test asserts the retired no-shell instruction');
  // The three sentences CL-D112 retired are no longer asserted through the file.
  assert.equal(readText('test/issue-111-gate-read-launch.test.js').includes("The installed package's own map governs a run"), false);
  assert.equal(readText('test/issue-34-bounded-recovery.test.js').includes('no retry beyond the CL-D39 recovery defined above'), false);
  assert.equal(readText('test/issue-74-composition-shapes.test.js').includes('the map names the shape each field expects'), false);
  assert.match(readText('contract/CL-D112.md'), /until CL-D118 repointed CL-D68-map's to CL-D68 and dropped the other two\./);
  const record = sectionOf(readContract(), '## CL-D118 — The rules only the mode references stated get a home or retire before their deletion');
  assert.ok(record, 'CL-D118 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6179573061/);
  assert.match(record, /tetsuh\/pi-tidd-agents#293/);
  for (const file of ['contract/CL-D44.md', 'contract/CL-D112.md', 'contract/CL-D118.md']) assert.ok(Buffer.byteLength(readText(file)) < 8000, `${file} stays under the record limit`);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D118.md') !== -1 && index.indexOf('contract/CL-D118.md') < index.indexOf('contract/CL-D117.md'), 'CL-D118 is indexed above CL-D117');
});

test('Issue #293 the mode references are byte-identical and no code changed', () => {
  for (const [file, digest] of Object.entries(REFERENCES)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(repoPath(file))).digest('hex'), digest, `${file} is unchanged`);
  for (const driver of ['review', 'autofix']) assert.ok(readText(`skills/closed-loop-pr/driver/${driver}.js`).includes("'skills/closed-loop-pr/references/helper-map.md'"), `${driver}.js still hashes the references into contractInput`);
});

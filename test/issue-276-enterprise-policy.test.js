'use strict';

// Issue #276 (CL-D125). The exact-autofix precondition requires the head branch to be verified writable by a normal
// non-force push, and a missing or unavailable writability result fails closed (CL-D30). `helpers/writability.js`
// refuses unless the caller proves that enterprise policy was collected completely, and the packaged driver passes
// that proof as a constant: it collects no enterprise policy of its own. The owner chose (a): record the assumption.
// The helper relies on GitHub's repository ruleset listing including the rulesets configured at higher levels that
// apply to the repository (its `includes_parents` default), so a ruleset that targets the repository from above appears
// in that listing and is evaluated like every other one; the constant asserts that nothing applies beyond the
// repository and organization listings the helper reads; a listing or detail the actor cannot read stops collection,
// and the driver ends BLOCKED before any gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readText, readManifest, manifestSources } = require('./helpers');
const writability = require('../skills/closed-loop-pr/helpers/writability');
const processHelper = require('../skills/closed-loop-pr/helpers/process');

const DRIVER = 'skills/closed-loop-pr/driver/autofix.js';
const RECORD = 'contract/CL-D125.md';
const CLAUSES = 'contract/CL-D125.clauses.json';
const CONSTANT = 'enterprisePolicyComplete: true, enterpriseRulesets: []';
const CALL = `run.op('writability', { owner, repo, branchRef: \`refs/heads/\${target.headBranch}\`, cwd: checkout, ${CONSTANT} });`;
const TITLE = 'The packaged driver collects no separate enterprise policy';

// The error the real transport raises when gh exits non-zero: process.js makes it safe and codes it `command_failed`.
// A fixture that threw a bare Error would pass for the wrong reason, with the helper's fallback code.
async function refusedByGh(text) {
  try { await processHelper.run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(text)}); process.exit(1);`], { phase: 'writability_collect', kind: 'gh' }); }
  catch (error) { return error; }
  throw new Error('the refused command resolved');
}
// A GitHub transport in the issue-47 style: the repository ruleset listing carries one repository ruleset and one
// ruleset configured above the repository, each read in detail at the repository endpoint.
function transportWith({ parent, listingError = null, detailError = null, calls = [] } = {}) {
  const repositoryRuleset = { id: 7, updated_at: '2026-01-01T00:00:00Z', enforcement: 'active', source_type: 'Repository' };
  const repositoryDetail = { ...repositoryRuleset, name: 'repository', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'non_fast_forward' }] };
  const parentRuleset = { id: 9, updated_at: '2026-01-02T00:00:00Z', enforcement: 'active', source_type: 'Enterprise' };
  const parentDetail = { ...parentRuleset, name: 'parent', target: 'branch', conditions: { repository_name: { include: ['~ALL'], exclude: [], protected: false }, ref_name: { include: ['~ALL'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'non_fast_forward' }], ...parent };
  const fn = async (_command, args) => {
    calls.push(args);
    const endpoint = args[args.length - 1];
    if (endpoint === 'repos/owner/repo') return { stdout: Buffer.from(JSON.stringify({ id: 1, owner: { type: 'User' }, default_branch: 'main', permissions: { push: true } })) };
    if (endpoint === 'user') return { stdout: Buffer.from('{"login":"owner"}') };
    if (String(endpoint).includes('/protection')) { const error = new Error('HTTP 404'); error.stderr = 'HTTP 404'; throw error; }
    if (endpoint === 'repos/owner/repo/rulesets') {
      if (listingError) throw listingError;
      return { stdout: Buffer.from(JSON.stringify([repositoryRuleset, parentRuleset])) };
    }
    if (endpoint === 'repos/owner/repo/rulesets/7') return { stdout: Buffer.from(JSON.stringify(repositoryDetail)) };
    if (endpoint === 'repos/owner/repo/rulesets/9') {
      if (detailError) throw detailError;
      return { stdout: Buffer.from(JSON.stringify(parentDetail)) };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  fn.calls = calls;
  fn.parentDetail = parentDetail;
  return fn;
}
const collect = (transport, over = {}) => writability.collectWritability({ owner: 'owner', repo: 'repo', branchRef: 'refs/heads/feature', enterprisePolicyComplete: true, enterpriseRulesets: [], transport, ...over });

test('Issue #276 the packaged driver passes the enterprise policy proof as a constant, once', () => {
  const driver = readText(DRIVER);
  assert.equal(driver.split(CALL).length - 1, 1, 'the driver makes exactly one writability call, with the pinned constant');
  assert.equal(driver.split('enterprisePolicyComplete').length - 1, 1, 'nothing else in the driver names the proof');
  assert.ok(driver.includes('writability (CL-D125)'), 'the driver carries the CL-D125 marker beside the call');
  assert.ok(driver.includes("run.op('writability', { owner, repo, branchRef: `refs/heads/${target.headBranch}`, cwd: checkout,"), 'the CL-D30-preconditions prefix pin still holds');
});

test('Issue #276 the helper refuses a caller that proves nothing', async () => {
  const transport = transportWith();
  const result = await collect(transport, { enterprisePolicyComplete: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'policy_collection_incomplete');
  assert.equal(result.error.phase, 'writability_collect');
});

test('Issue #276 a ruleset configured above the repository is evaluated from the repository listing', async () => {
  const transport = transportWith();
  const result = await collect(transport);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.source.repositoryRulesets.map((r) => r.id), [7, 9]);
  assert.deepEqual(result.data.source.organizationRulesets, []);
  assert.equal(transport.calls.filter((args) => args.at(-1) === 'repos/owner/repo/rulesets/9').length, 1);
});

test('Issue #276 a ruleset configured above the repository restricts the push like every other one', async () => {
  const transport = transportWith({ parent: { rules: [{ type: 'pull_request' }] } });
  const result = await collect(transport);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'normal_push_restricted');
  assert.equal(result.error.details.evaluation.ruleset, 'parent');
  const bypass = await collect(transportWith({ parent: { bypass_actors: [{ actor_id: 1, actor_type: 'Team', bypass_mode: 'always' }] } }));
  assert.equal(bypass.ok, false);
  assert.equal(bypass.error.code, 'bypass_dependency');
});

test('Issue #276 an unreadable listing or detail stops collection before evaluation', async () => {
  const refusal = await refusedByGh('HTTP 403: Resource protected by organization policy');
  assert.equal(refusal.code, 'command_failed', 'process.js codes a non-zero gh exit command_failed');
  const listing = transportWith({ listingError: refusal });
  const refused = await collect(listing);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'command_failed');
  assert.equal(refused.error.phase, 'writability_collect');
  assert.equal(listing.calls.filter((args) => String(args.at(-1)).includes('/rulesets/')).length, 0, 'no detail is read after a refused listing');
  const detail = transportWith({ detailError: refusal });
  const unreadable = await collect(detail);
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.error.code, 'command_failed');
  assert.equal(unreadable.error.phase, 'writability_collect');
  assert.equal(detail.calls.filter((args) => args.at(-1) === 'repos/owner/repo/rulesets').length, 1, 'collection stops at the unreadable detail, before the closing listing');
  const incomplete = await collect(transportWith({ parent: { bypass_actors: undefined } }));
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error.code, 'invalid_schema', 'a detail without its bypass actors is a schema gap');
  assert.equal(incomplete.error.phase, 'writability_collect');
});

test('Issue #276 the record states the assumption and agrees with the driver', () => {
  const record = readText(RECORD);
  assert.ok(Buffer.byteLength(record) < 8000);
  assert.match(record, new RegExp(`^## CL-D125 — ${TITLE}\\n\\*\\*Clauses:\\*\\* CL-D125-record, CL-D125-driver\\n`));
  assert.ok(record.includes('The packaged driver collects no enterprise policy of its own.'));
  assert.ok(record.includes('The helper relies on GitHub\'s repository ruleset listing including the rulesets configured at higher levels that apply to the repository (its `includes_parents` default), so a ruleset that targets the repository from above appears in that listing and is evaluated like every other one.'));
  assert.ok(record.includes(`The driver's \`writability\` call passes \`${CONSTANT}\`, which asserts that nothing applies beyond the repository and organization listings the helper reads.`));
  assert.ok(record.includes('A listing or ruleset detail the actor cannot read stops collection, and the driver ends `BLOCKED` before any gate runs.'));
  // The record and the driver agree on the constant: the same text, byte for byte.
  const pinned = readText(DRIVER).match(/enterprisePolicyComplete: [^,]+, enterpriseRulesets: \[[^\]]*\]/);
  assert.ok(pinned, 'the driver names the constant');
  assert.ok(record.includes(`\`${pinned[0]}\``), 'the record quotes the driver constant exactly');
  assert.match(readText('CONTRACT.md'), new RegExp(`- \\[contract/CL-D125\\.md\\]\\(contract/CL-D125\\.md\\) — ${TITLE}\\n`));
  const clauses = readManifest().clauses.filter((c) => c.id.startsWith('CL-D125'));
  assert.deepEqual(clauses.map((c) => c.id), ['CL-D125-record', 'CL-D125-driver']);
  assert.ok(manifestSources().includes(CLAUSES), 'the CL-D125 clauses sit beside the record');
  const driverClause = clauses.find((c) => c.id === 'CL-D125-driver');
  assert.deepEqual(driverClause.files, [DRIVER]);
  assert.ok(driverClause.requires.includes(CALL), 'the clause pins the whole writability call');
  assert.ok(driverClause.requires.includes('writability (CL-D125)'));
  const recordClause = clauses.find((c) => c.id === 'CL-D125-record');
  assert.deepEqual(recordClause.files, [RECORD]);
  assert.ok(recordClause.requires.includes('The packaged driver collects no enterprise policy of its own.'));
});

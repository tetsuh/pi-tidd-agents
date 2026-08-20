'use strict';

// Issue #34 / CL-D39: the owner retained Option A for exact PR autofix only. Review found
// the first draft of this record overstated its basis, so the guard now pins what is actually
// true: exact autofix has no recovery path, the other two modes keep their existing single
// malformed-verdict retry, and the narrowing mechanisms that support the decision stay in
// place without being claimed to make any failure class impossible.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson } = require('./helpers');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const CLI = 'skills/closed-loop-pr/helpers/cli.js';
const CONTRACT = 'CONTRACT.md';

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

test('Issue #34 the exact-autofix stop rule is retained verbatim and gains no recovery path', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop\./);
  assert.match(text, /This stop is CL-D39 and applies to exact autofix at every phase: no phase has a recovery path\./);
  // Option B would have introduced a bounded local retry. No such escape may exist.
  for (const forbidden of [/recovery budget/i, /one local recovery/i, /prevalidated operation/i, /recoverable pre-mutation/i]) {
    assert.doesNotMatch(text, forbidden, `the mode reference must not carry an Option B recovery path: ${forbidden}`);
  }
});

test('Issue #34 CL-D39 is scoped to exact autofix and claims only what holds', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Exact-autofix tooling failures remain terminal without recovery');
  assert.ok(section, 'CL-D39 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-structural$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option A, scoped to exact PR `autofix`/);
  assert.match(section, /Issue and PR review-only keep their existing single malformed-verdict retry unchanged/);
  // The withdrawn claims must not return: review established each was unsupported.
  for (const withdrawn of [
    /structurally impossible/,
    /Both occur after Luna's edit/,
    /recover approximately nothing/,
    /in every mode and at every phase/,
  ]) assert.doesNotMatch(section, withdrawn, `CL-D39 must not restate a withdrawn claim: ${withdrawn}`);
  // and the corrected evidence must be recorded instead
  assert.match(section, /rejects unknown fields without preventing selection of the wrong known field/);
  assert.match(section, /all accept an `oid` so a same-typed cross-domain mix-up remains reachable/);
  assert.match(section, /the staged-manifest comparison is still performed by orchestrator logic/);
  assert.match(section, /reachable before any edit and a recovery path would not be empty/);
});

test('Issue #34 the other two modes keep the retry CL-D39 does not touch', () => {
  // CL-D39 is scoped to exact autofix precisely because these two contracts already retry.
  for (const file of ['skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-issue/SKILL.md']) {
    assert.match(readText(file), /retry the invocation once, and if it fails again report `BLOCKED`/, `${file} must keep its existing single retry`);
  }
});

test('Issue #34 the narrowing mechanisms behind the decision stay in place', () => {
  // These mechanisms narrow the surface that produces incidental defects. They do not make
  // any failure class impossible, and CL-D39 no longer claims they do; they are pinned
  // because weakening them would weaken the basis for taking Option A now.
  assert.match(readText(PR_AUTOFIX), /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/,
    'malformed run-time shell/jq is prevented by the invocation map');
  assert.match(readText(GATE_CONTRACT), /never parse those fields from Markdown/,
    'ad-hoc envelope field access is prevented by the structured transport');

  // Distinct byte domains: each fingerprint operation takes its own input field, so a digest
  // cannot be computed from the wrong domain by passing the wrong key.
  const table = readText(CLI).match(/const SCHEMAS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(table, 'could not locate the CLI schema table');
  const domains = new Map();
  for (const [, operation, required] of table[1].matchAll(/^\s*(fingerprint_[a-z0-9_]+):\s*\{\s*required:\s*\[([^\]]*)\]/gm)) {
    domains.set(operation, (required.match(/'([^']+)'/g) || []).map((field) => field.slice(1, -1)));
  }
  assert.equal(domains.size, 7, `expected seven fingerprint operations, found ${domains.size}`);
  assert.deepEqual(domains.get('fingerprint_pr_diff'), ['base64'], 'the binary diff domain must take raw bytes, never text');
  assert.deepEqual(domains.get('fingerprint_issue_spec').slice().sort(), ['body', 'comments']);
  const single = [...domains.values()].every((fields) => fields.length >= 1);
  assert.ok(single, 'every fingerprint operation must declare its own input domain');
});

test('Issue #34 the surviving classes are routed to follow-up, not to recovery', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Exact-autofix tooling failures remain terminal without recovery');
  assert.match(section, /tracked in #64/, 'the structural follow-up must be named');
  assert.match(section, /whether it should is reopened separately with that corrected evidence/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-stop', 'CL-D39-structural'],
  );
});

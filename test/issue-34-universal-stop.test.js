'use strict';

// Issue #34 / CL-D39: the owner retained Option A, the universal pre-mutation stop rule.
// The decision is only defensible because the failure classes Option B would have recovered
// were removed structurally by #47, #55, and #37 rather than made recoverable. This guard
// pins both halves: the rule itself, and the structural properties that justify keeping it.

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

test('Issue #34 the universal stop rule is retained verbatim and gains no recovery path', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop\./);
  // Option B would have introduced a bounded local retry. No such escape may exist.
  for (const forbidden of [/recovery budget/i, /one local recovery/i, /prevalidated operation/i, /recoverable pre-mutation/i]) {
    assert.doesNotMatch(text, forbidden, `the mode reference must not carry an Option B recovery path: ${forbidden}`);
  }
});

test('Issue #34 CL-D39 records Option A with the evidence that makes it defensible', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Pre-mutation tooling failures remain universally terminal');
  assert.ok(section, 'CL-D39 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-structural$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option A/);
  // The decision must record why the issue's own recommendation was not taken.
  assert.match(section, /Issue #34 recommended Option B/);
  assert.match(section, /three of the five failure classes it names are now structurally impossible/);
  assert.match(section, /Both occur after Luna's edit, where `CLEAN@H` no longer holds/);
  assert.match(section, /Option B would recover approximately nothing/);
  assert.match(section, /make the remaining classes impossible rather than recoverable/);
});

test('Issue #34 the three structurally removed failure classes stay removed', () => {
  // Each assertion pins the mechanism that replaced a class Option B would have recovered.
  // If one regresses, the basis for Option A regresses with it and CL-D39 must be revisited.
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

test('Issue #34 the two surviving classes are named and routed to follow-up, not to recovery', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Pre-mutation tooling failures remain universally terminal');
  for (const surviving of ['validation harness', 'staged-manifest assertion']) {
    assert.ok(section.includes(surviving), `CL-D39 must name the surviving class: ${surviving}`);
  }
  assert.match(section, /neither is recoverable under Option B's own conditions/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-stop', 'CL-D39-structural'],
  );
});

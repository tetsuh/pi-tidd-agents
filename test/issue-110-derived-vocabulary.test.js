'use strict';

// Issue #110 (CL-D63) — the role set, gate identities, gate order, status grammar, and restart
// phrase are declared once in test/records/workflow-vocabulary.json, and every declared prose
// surface is checked against literals derived from it. Phrases a decision retired are denied
// everywhere except on a line carrying the recorded qualification. Nothing here classifies
// prose: each check is a literal on a declared surface (CL-D44), and the denylist grows only
// when a decision retires a phrase (CL-D43/CL-D48).
//
// TDD provenance: recorded with `node --test test/issue-110-derived-vocabulary.test.js` at RED
// before the payload sentences, the CL-D63 record, and the manifest clauses existed; the
// derived-surface checks were GREEN against the CL-D62 tree, which is the point of deriving
// them. That local output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, readJson, repoPath, parseFrontmatter, sectionOf } = require('./helpers');

const VOCAB = readJson('test/records/workflow-vocabulary.json');
const ROLES = VOCAB.roles;
const byRoot = (root, kinds) => ROLES.filter((role) => role.roots.includes(root) && kinds.includes(role.kind)).map((role) => role.name);
const code = (name) => `\`${name}\``;
const list = (names) => names.length === 2 ? `${code(names[0])} and ${code(names[1])}` : `${names.slice(0, -1).map(code).join(', ')}, and ${code(names[names.length - 1])}`;
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);

function proseFiles() {
  const out = ['README.md', 'CONTRACT.md'];
  for (const dir of ['agents', 'prompts']) for (const f of fs.readdirSync(repoPath(dir))) if (f.endsWith('.md')) out.push(`${dir}/${f}`);
  const walk = (dir) => { for (const entry of fs.readdirSync(repoPath(dir), { withFileTypes: true })) { const p = `${dir}/${entry.name}`; if (entry.isDirectory()) walk(p); else if (entry.name.endsWith('.md')) out.push(p); } };
  walk('skills');
  return out;
}

test('Issue #110 the vocabulary source matches the packaged agents and the envelope schema', () => {
  assert.equal(VOCAB.schemaVersion, 1);
  const files = fs.readdirSync(repoPath('agents')).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(files, ROLES.map((role) => `${role.name}.md`).sort(), 'agents/ is exactly the declared role set');
  for (const role of ROLES) {
    const frontmatter = parseFrontmatter(readText(`agents/${role.name}.md`));
    assert.equal(frontmatter.name, role.name);
    assert.equal(frontmatter.model, role.model, `${role.name} model`);
    assert.equal(frontmatter.defaultContext, role.context, `${role.name} context`);
    assert.equal(frontmatter.aliases, role.alias, `${role.name} alias`);
  }
  assert.deepEqual(gateResult.SCHEMA.properties.correlation.properties.gate.enum, VOCAB.gateIdentities, 'the shipping schema carries exactly the declared gate identities');
  assert.deepEqual(ROLES.filter((role) => role.gate).map((role) => role.gate).sort(), [...VOCAB.gateIdentities].sort(), 'every gate identity belongs to one role');
  for (const gate of VOCAB.gateIdentities) {
    const root = VOCAB.gateOrder.issue.includes(gate) ? 'issue' : 'pr';
    const findingId = `${VOCAB.prefixes[gate]}-110-DERIVED`;
    const finding = {
      findingId, origin: 'fresh', gate, headOid: OID, raisedAgainstFingerprint: SHA, severity: 'Minor', anchoring: 'criterion-anchored', anchor: 'AC', proposedDisposition: 'fixed',
      evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending',
      workflowRecord: root === 'pr'
        ? { sourceKind: 'gate', sourceId: findingId, authorIdentity: 'x', authorType: 'Agent', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'c' }
        : { candidateIdentity: 'c', revisedPassage: 'p', snapshotAssignment: 's' },
    };
    const correlation = { repository: 'o/r', number: 110, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
    const envelope = { schemaVersion: 2, correlation, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }], findings: [finding], confirmations: [], decisions: [], adversarialResults: gate === 'adversarial' ? [{ claim: 'c', searched: 's', outcome: 'counterexample', evidence: 'e', findingId }] : [] };
    const result = gateResult.validateGateResult(envelope, { workflow: root, correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
    assert.equal(result.ok, true, `${gate}: the declared prefix ${VOCAB.prefixes[gate]} is the derived namespace: ${JSON.stringify(result.error ?? {})}`);
  }
});

test('Issue #110 every declared role surface derives from the source', () => {
  const readme = readText('README.md');
  for (const role of ROLES) assert.ok(readme.includes(`| ${code(role.name)} | ${code(role.model)} |`), `README Included agents row for ${role.name}`);
  const issuePre = byRoot('issue', ['reviewer', 'preliminary']), prPre = byRoot('pr', ['reviewer', 'preliminary']);
  assert.ok(readme.includes(`\`/tidd-issue\` preflights ${list(issuePre)}; \`/tidd-pr\` preflights ${list(prPre)}, and adds ${code(byRoot('pr', ['writer'])[0])} in \`autofix\` mode`), 'README per-command preflight sentence');
  const issuePreflight = sectionOf(readText('skills/closed-loop-issue/SKILL.md'), '## Preflight (CL-D22, CL-D5)');
  for (const name of issuePre) assert.ok(issuePreflight.includes(code(name)), `Issue root preflight names ${name}`);
  const prSkill = readText('skills/closed-loop-pr/SKILL.md');
  for (const name of [...prPre, ...byRoot('pr', ['writer'])]) assert.ok(prSkill.includes(code(name)), `PR root preflight names ${name}`);
  const resolution = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '## Name-level agent resolution (CL-D22, CL-D5, CL-D59)');
  for (const role of ROLES) assert.ok(resolution.includes(code(role.name)), `shared resolution names ${role.name}`);
});

test('Issue #110 every declared gate-order surface follows the source order', () => {
  const roleOf = (gate) => ROLES.find((role) => role.gate === gate).name;
  const inOrder = (text, needles, label) => { let at = -1; for (const needle of needles) { const next = text.indexOf(needle, at + 1); assert.ok(next > at, `${label}: ${needle} must follow the previous stage`); at = next; } };
  inOrder(sectionOf(readText('skills/closed-loop-pr/references/review-only.md'), '## Gate loop (PR review-only baseline; AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)'), VOCAB.gateOrder.pr.map((gate) => `→ ${roleOf(gate)} `), 'review-only order block');
  const legacy = readText('skills/closed-loop-issue/SKILL.md').split('\n').find((line) => line.startsWith('specification → '));
  assert.ok(legacy, 'the Issue legacy sequence line exists');
  inOrder(legacy, VOCAB.gateOrder.issue.map((gate) => `→ ${roleOf(gate)} `), 'Issue legacy sequence');
  const flow = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  inOrder(flow, ['\nCONVERGENCE: ', '\nSOL:   ', '\nTERRA: ', '\nFINAL_CHECK: '], 'exact-autofix flow block');
  const shared = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '## Convergence stage (CL-D62)');
  assert.ok(shared.includes(`Issue \`${VOCAB.gateOrder.issue.join(' → ')}\`, PR \`${VOCAB.gateOrder.pr.join(' → ')}\``), 'shared order sentence derives from the source');
});

test('Issue #110 status grammar lines derive from the source', () => {
  for (const [root, file] of [['issue', 'skills/closed-loop-issue/SKILL.md'], ['pr', 'skills/closed-loop-pr/references/review-only.md']]) {
    const text = readText(file);
    for (const line of [VOCAB.statusLines.rounds, VOCAB.statusLines.resolved, VOCAB.statusLines.activeGate[root]]) assert.ok(text.includes(`\n${line}\n`), `${file} status block carries: ${line}`);
  }
  for (const file of ['README.md', 'skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/references/autofix-addendum.md']) assert.ok(readText(file).includes(VOCAB.restart), `${file} uses the declared restart phrase`);
});

test('Issue #110 retired phrases do not survive outside their recorded qualification', () => {
  const offenders = [];
  for (const file of proseFiles()) {
    const lines = readText(file).split('\n');
    lines.forEach((line, index) => {
      for (const retired of VOCAB.retiredPhrases) {
        if (!new RegExp(retired.pattern).test(line)) continue;
        if (retired.allowedWith && line.includes(retired.allowedWith)) continue;
        offenders.push(`${file}:${index + 1} [${retired.retiredBy}] /${retired.pattern}/`);
      }
    });
  }
  assert.deepEqual(offenders, [], `retired phrases survive:\n${offenders.join('\n')}`);
  for (const retired of VOCAB.retiredPhrases) assert.match(retired.retiredBy, /^CL-D\d+$/, 'every denylist entry names the decision that retired it');
});

test('Issue #110 the Sol-only payload block pre-checks derived surfaces and CL-D63 records the layer', () => {
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(block);
  assert.match(block, /When the target repository pins surfaces by derived-vocabulary and retired-phrase tests, those surfaces are pre-checked deterministically: do not re-raise a surface-agreement gap they cover as a finding/);
  assert.match(block, /when a surface-agreement gap is found on a surface they do not cover, enumerate every instance across the target in one result rather than one per round \(CL-D63\)/);
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D63 — Deterministic agreement checks are the first review layer');
  assert.ok(record, 'CL-D63 must exist');
  for (const field of ['*Decision ID:* CL-D63', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D63 must carry ${field}`);
  assert.match(record, /issues\/110/);
  assert.match(record, /validate declared surfaces with literals derived from one source; never classify prose/);
  assert.match(record, /a denylist entry is added only when a decision retires a phrase/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D63').map((clause) => clause.id).sort(), ['CL-D63-payload', 'CL-D63-tests']);
});

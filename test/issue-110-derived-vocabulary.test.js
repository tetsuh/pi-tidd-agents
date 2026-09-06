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
const display = (gate) => { const role = ROLES.find((candidate) => candidate.gate === gate); return role.nickname ?? gate; };
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const ROLE_TOKEN = /tidd-[a-z-]+-(?:reviewer|worker)/g;

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
  // CONV-113-SURFACE-COVERAGE-001: the README role paragraph and the helper-map rows derive too.
  const canonical = ROLES.filter((role) => role.alias).map((role) => role.name), preliminary = ROLES.filter((role) => role.kind === 'preliminary').map((role) => role.name);
  assert.ok(readme.includes(`The closed-loop workflow uses ${NUMBER_WORDS[ROLES.length]} roles: ${canonical.map(code).join(', ')}, and the non-authoritative ${code(preliminary[0])} (CL-D62).`), 'README role paragraph derives from the source');
  const prDisplay = VOCAB.gateOrder.pr.map(display);
  const autofix = readText('skills/closed-loop-pr/references/autofix.md');
  assert.ok(autofix.includes(`| Snapshot refresh — before each ${prDisplay.join('/')} invocation, before the first reply`), 'helper map snapshot row derives from the PR gate order');
  assert.ok(autofix.includes(`| Every ${prDisplay[0]}, ${prDisplay[1]}, or ${prDisplay[2]} result, before it is read as a verdict (CL-D36, CL-D62) | \`gate_result_validate\` |`), 'helper map validate row derives from the PR gate order');
});

test('Issue #110 every declared gate-order surface follows the source order', () => {
  const roleOf = (gate) => ROLES.find((role) => role.gate === gate).name;
  const inOrder = (text, needles, label) => { let at = -1; for (const needle of needles) { const next = text.indexOf(needle, at + 1); assert.ok(next > at, `${label}: ${needle} must follow the previous stage`); at = next; } };
  inOrder(sectionOf(readText('skills/closed-loop-pr/references/review-only.md'), '## Gate loop (PR review-only baseline; AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)'), VOCAB.gateOrder.pr.map((gate) => `→ ${roleOf(gate)} `), 'review-only order block');
  const legacy = readText('skills/closed-loop-issue/SKILL.md').split('\n').find((line) => line.startsWith('specification → '));
  assert.ok(legacy, 'the Issue legacy sequence line exists');
  inOrder(legacy, VOCAB.gateOrder.issue.map((gate) => `→ ${roleOf(gate)} `), 'Issue legacy sequence');
  const flow = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  inOrder(flow, [...VOCAB.gateOrder.pr.map((gate) => `\n${display(gate).toUpperCase()}: `), '\nFINAL_CHECK: '], 'exact-autofix flow block');
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

// CONV-113-VOCAB-CROSSCHECK (convergence, PR #113): acceptance criterion 1 also requires the role and
// gate literals that older fixtures and manifest clauses carry to be cross-checked against the source.
// Each check below is a literal on a declared line of a declared file, never a rewrite of that fixture.
test('Issue #110 existing role and gate fixtures cross-check the source', () => {
  const rolesFixture = readText('test/issue-100-tidd-roles.test.js');
  for (const role of ROLES) {
    const alias = role.alias === undefined ? 'undefined' : `'${role.alias}'`;
    assert.ok(rolesFixture.includes(`'${role.name}': { alias: ${alias}, model: '${role.model}', writer: ${role.kind === 'writer'}, context: '${role.context}' }`), `issue-100 ROLES entry for ${role.name}`);
  }
  const packageTest = readText('test/package.test.js');
  for (const role of ROLES) assert.ok(packageTest.includes(`'${role.name}': '${role.model}',`), `package.test EXPECTED_AGENTS entry for ${role.name}`);
  const agentTools = readText('test/issue-49-agent-tools.test.js');
  for (const role of ROLES) assert.ok(agentTools.includes(`'${role.name}'`), `issue-49 lists ${role.name}`);
  const gateIds = readText('test/issue-100-gate-ids-v2.test.js');
  assert.ok(gateIds.includes(`const V2_GATES = [${VOCAB.gateIdentities.map((gate) => `'${gate}'`).join(', ')}];`), 'issue-100-gate-ids-v2 V2_GATES equals the declared identities');
  const convergence = readText('test/issue-101-convergence-stage.test.js');
  assert.ok(convergence.includes(`[${VOCAB.gateIdentities.map((gate) => `'${gate}'`).join(', ')}]`), 'issue-101 pins the declared identity list');
  assert.ok(convergence.includes(`Issue \`${VOCAB.gateOrder.issue.join(' → ')}\`, PR \`${VOCAB.gateOrder.pr.join(' → ')}\``), 'issue-101 pins the declared gate order');
  assert.ok(convergence.includes(`${VOCAB.prefixes.convergence}-101-`), 'issue-101 uses the declared convergence namespace');
  const manifest = readJson('test/contract-clauses.json');
  const requires = (id) => { const clause = manifest.clauses.find((candidate) => candidate.id === id); assert.ok(clause, `manifest clause ${id}`); return clause.requires; };
  const canonical = ROLES.filter((role) => role.alias).map((role) => role.name);
  assert.ok(requires('CL-D59-resolution').includes(list(canonical)), 'CL-D59-resolution names the four CL-D59 roles from the source');
  const formalPrefixes = VOCAB.gateIdentities.filter((gate) => gate !== 'convergence').map((gate) => `\`${VOCAB.prefixes[gate]}-<n>-\``);
  assert.ok(requires('CL-D60-identities').includes(`the derived fresh-finding namespaces are ${formalPrefixes[0]}, ${formalPrefixes[1]}, and ${formalPrefixes[2]}`), 'CL-D60-identities names the derived namespaces from the source');
  assert.ok(requires('CL-D60-identities').includes(`Gate identities (CL-D60): under envelope schema version 2 the gate is \`${VOCAB.gateIdentities[0]}\``), 'CL-D60-identities starts with the first declared identity');
  assert.ok(requires('CL-D62-shared').includes('the sequence restarts at convergence'), 'CL-D62-shared names the convergence restart');
  for (const id of ['CL-D62-issue', 'CL-D62-pr']) assert.ok(requires(id).includes(VOCAB.statusLines.rounds), `${id} pins the declared rounds line`);
  assert.ok(requires('CL-D62-autofix-flow').some((literal) => literal.startsWith(`${display('convergence').toUpperCase()}: MERGE -> ${display('adversarial').toUpperCase()};`)), 'CL-D62-autofix-flow pins the declared first flow line');
  // CONV-113-MANIFEST-CROSSCHECK-001 / CONV-113-SURFACE-COVERAGE-001: the checks are two-way. The fixture
  // constants carry exactly the declared role set, and every role-shaped token in the role/gate clauses
  // and the named fixtures is a declared role; a stale extra fails by name.
  const declared = ROLES.map((role) => role.name).sort();
  assert.deepEqual([...rolesFixture.matchAll(/'(tidd-[a-z-]+)': \{ alias:/g)].map((match) => match[1]).sort(), declared, 'issue-100 ROLES keys are exactly the declared roles');
  assert.deepEqual([...packageTest.matchAll(/^  '(tidd-[a-z-]+)': 'gpt-[^']+',$/gm)].map((match) => match[1]).sort(), declared, 'package.test EXPECTED_AGENTS keys are exactly the declared roles');
  const reviewers = agentTools.match(/const REVIEWERS = \[([^\]]+)\]/), workers = agentTools.match(/const WORKERS = \[([^\]]+)\]/);
  assert.deepEqual([...`${reviewers[1]},${workers[1]}`.matchAll(/'(tidd-[a-z-]+)'/g)].map((match) => match[1]).sort(), declared, 'issue-49 REVIEWERS plus WORKERS are exactly the declared roles');
  const roleClauses = manifest.clauses.filter((clause) => ['CL-D59', 'CL-D60', 'CL-D62', 'CL-D63'].includes(clause.marker));
  assert.ok(roleClauses.length >= 10, 'the role and gate clauses are present');
  const gateWords = new Set([...VOCAB.gateIdentities, 'sol', 'terra']);
  for (const clause of roleClauses) for (const literal of clause.requires) {
    for (const token of literal.match(ROLE_TOKEN) || []) assert.ok(declared.includes(token), `${clause.id}: undeclared role ${token}`);
    for (const match of literal.matchAll(/`(adversarial|decision-drift|safety|convergence|sol|terra)`/g)) assert.ok(gateWords.has(match[1]), `${clause.id}: undeclared gate ${match[1]}`);
  }
  for (const file of [...proseFiles(), 'test/contract-clauses.json', 'test/issue-100-tidd-roles.test.js', 'test/issue-101-convergence-stage.test.js', 'test/issue-49-agent-tools.test.js', 'test/package.test.js', 'test/issue-100-gate-ids-v2.test.js']) {
    for (const token of readText(file).match(ROLE_TOKEN) || []) assert.ok(declared.includes(token), `${file}: undeclared role ${token}`);
  }
});

// Convergence lead on PR #113 (non-authoritative): the version 1 window's gates, prefixes, and the
// marker's gate vocabulary were outside the source. They are declared now and checked against the
// shipping code and the one fixture that names them.
test('Issue #110 the version 1 window and the marker gate vocabulary derive from the source', () => {
  const helpers = require('../skills/closed-loop-pr/helpers');
  const window = VOCAB.version1Window;
  assert.deepEqual(gateResult.SCHEMAS[1].properties.correlation.properties.gate.enum, window.gates, 'the version 1 schema carries exactly the declared window gates');
  for (const gate of window.gates) {
    const findingId = `${window.prefixes[gate]}-110-WINDOW`;
    const correlation = { repository: 'o/r', number: 110, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
    const finding = { findingId, origin: 'fresh', gate, headOid: OID, raisedAgainstFingerprint: SHA, severity: 'Minor', anchoring: 'criterion-anchored', anchor: 'AC', proposedDisposition: 'fixed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending', workflowRecord: { sourceKind: 'gate', sourceId: findingId, authorIdentity: 'x', authorType: 'Agent', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'c' } };
    const envelope = { schemaVersion: 1, correlation, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }], findings: [finding], confirmations: [], decisions: [], adversarialResults: gate === 'sol' ? [{ claim: 'c', searched: 's', outcome: 'counterexample', evidence: 'e', findingId }] : [] };
    const result = gateResult.validateGateResult(envelope, { workflow: 'pr', correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
    assert.equal(result.ok, true, `${gate}: the declared window prefix is the version 1 namespace: ${JSON.stringify(result.error ?? {})}`);
  }
  for (const gates of window.markerGates) {
    const made = helpers.createReplyMarker({ binding: { repository: 'o/r', number: 110, sourceKind: 'issue_comment', sourceId: '1', sourceUrl: 'https://github.com/o/r/pull/110#issuecomment-1', sourceBodySha256: SHA, sourceCreatedAt: '2026-09-07T00:00:00Z', sourceUpdatedAt: '2026-09-07T00:00:00Z', head: OID, findings: [{ findingId: 'ADV-110-M', disposition: 'fixed' }], gates, commit: null }, visibleBody: 'Confirming gate.\n' });
    assert.equal(made.ok, true, `marker gates ${gates}: ${JSON.stringify(made.error ?? {})}`);
  }
  assert.equal(helpers.createReplyMarker({ binding: { repository: 'o/r', number: 110, sourceKind: 'issue_comment', sourceId: '1', sourceUrl: 'https://github.com/o/r/pull/110#issuecomment-1', sourceBodySha256: SHA, sourceCreatedAt: '2026-09-07T00:00:00Z', sourceUpdatedAt: '2026-09-07T00:00:00Z', head: OID, findings: [{ findingId: 'ADV-110-M', disposition: 'fixed' }], gates: 'luna', commit: null }, visibleBody: 'Confirming gate.\n' }).ok, false, 'an undeclared marker gate is rejected');
  assert.ok(readText('test/issue-100-gate-ids-v2.test.js').includes(`const V1_GATES = [${window.gates.map((gate) => `'${gate}'`).join(', ')}];`), 'issue-100-gate-ids-v2 V1_GATES equals the declared window gates');
});

'use strict';

// Issue #110 (CL-D63) — the role set, gate identities, gate order, status grammar, and restart
// phrase are declared once in test/records/workflow-vocabulary.json, and every declared prose
// surface is checked against literals derived from it. Phrases a decision retired are denied
// everywhere except on a line carrying the recorded qualification. Nothing here classifies
// prose: each check is a literal on a declared surface (CL-D44), and the denylist grows only
// when a decision retires a phrase (CL-D43/CL-D48).
//
// TDD provenance: pre-implementation compile/contract RED for the RED-producing assertion, which
// inspected artifact text (the payload sentences, the CL-D63 record, and the manifest clauses),
// recorded with `node --test test/issue-110-derived-vocabulary.test.js` at 5 passes / 1 failure before
// those existed. The initial suite also contained passing behavioral namespace checks that run gate
// envelopes through `gate_result_validate`; the derived-surface checks were GREEN against the CL-D62
// tree, which is the point of deriving them. Later tests are review-driven regressions; the last one
// (ADV-113-EXHAUSTIVE-GAPS-001) was a compile RED at 8 passes / 1 failure before the collectors it
// calls existed, and its wrong-root and duplicate-stage mutations (ADV-113-GATE-ORDER-EXACTNESS-001)
// were a contract RED at 8 passes / 1 failure while the order scan was still a subsequence search, as
// were its relocated-status-line and second-fence mutations (ADV-113-STATUS-BLOCK-SCOPE-001) while the
// status check was a whole-file search. That local output is not claimed as repository-preserved evidence.
//
// Shape (ADV-113-EXHAUSTIVE-GAPS-001): each surface check is a collector that takes a reader and
// returns every gap it found as a string; a test asserts the collector's result is empty exactly once,
// so a single run names every location rather than stopping at the first.

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
const quoted = (names) => names.map((name) => `'${name}'`).join(', ');
const list = (names) => names.length === 2 ? `${code(names[0])} and ${code(names[1])}` : `${names.slice(0, -1).map(code).join(', ')}, and ${code(names[names.length - 1])}`;
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const display = (gate) => { const role = ROLES.find((candidate) => candidate.gate === gate); return role.nickname ?? gate; };
const roleOf = (gate) => ROLES.find((role) => role.gate === gate).name;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const ROLE_TOKEN = /tidd-[a-z-]+-(?:reviewer|worker)/g;
const DECLARED = ROLES.map((role) => role.name).sort();

function proseFiles() {
  const out = ['README.md', 'CONTRACT.md'];
  for (const dir of ['agents', 'prompts']) for (const f of fs.readdirSync(repoPath(dir))) if (f.endsWith('.md')) out.push(`${dir}/${f}`);
  const walk = (dir) => { for (const entry of fs.readdirSync(repoPath(dir), { withFileTypes: true })) { const p = `${dir}/${entry.name}`; if (entry.isDirectory()) walk(p); else if (entry.name.endsWith('.md')) out.push(p); } };
  walk('skills');
  return out;
}

// A collector records a gap instead of throwing; `expect` mirrors assert.ok, `same` mirrors deepEqual
// on sorted string sets and names the missing and extra members so one line locates the drift.
function collector() {
  const gaps = [];
  const expect = (ok, gap) => { if (!ok) gaps.push(gap); };
  const same = (actual, expected, label) => {
    const missing = expected.filter((item) => !actual.includes(item)), extra = actual.filter((item) => !expected.includes(item));
    if (missing.length || extra.length) gaps.push(`${label}:${missing.length ? ` missing ${missing.join(', ')}` : ''}${extra.length ? ` extra ${extra.join(', ')}` : ''}`);
  };
  const section = (text, heading, label) => { const block = sectionOf(text, heading); expect(block, `${label}: section "${heading}" is missing`); return block ?? ''; };
  const exact = (actual, expected, label) => expect(JSON.stringify(actual) === JSON.stringify(expected), `${label}: found ${actual.join(', ')}; declared ${expected.join(', ')}`);
  return { gaps, expect, same, section, exact };
}
const withOverlay = (overlay) => (file) => overlay.has(file) ? overlay.get(file) : readText(file);
const assertNoGaps = (gaps, label) => assert.deepEqual(gaps, [], `${label}:\n${gaps.join('\n')}`);

function agentGaps(read) {
  const { gaps, expect } = collector();
  for (const role of ROLES) {
    const frontmatter = parseFrontmatter(read(`agents/${role.name}.md`));
    expect(frontmatter.name === role.name, `${role.name} frontmatter name is ${frontmatter.name}`);
    expect(frontmatter.model === role.model, `${role.name} model is ${frontmatter.model}, declared ${role.model}`);
    expect(frontmatter.defaultContext === role.context, `${role.name} context is ${frontmatter.defaultContext}, declared ${role.context}`);
    expect(frontmatter.aliases === role.alias, `${role.name} alias is ${frontmatter.aliases}, declared ${role.alias}`);
  }
  return gaps;
}

function roleSurfaceGaps(read) {
  const { gaps, expect, section, exact } = collector();
  const readme = read('README.md');
  // The role rows inside the Included agents table are an exact ordered list of role and model cells.
  const table = section(readme, '## Included agents', 'README');
  exact(table.split('\n').filter((line) => /^\| `tidd-/.test(line)).map((line) => line.split('|').slice(1, 3).map((cell) => cell.trim()).join(' | ')), ROLES.map((role) => `${code(role.name)} | ${code(role.model)}`), 'README Included agents rows');
  const issuePre = byRoot('issue', ['reviewer', 'preliminary']), prPre = byRoot('pr', ['reviewer', 'preliminary']);
  expect(readme.includes(`\`/tidd-issue\` preflights ${list(issuePre)}; \`/tidd-pr\` preflights ${list(prPre)}, and adds ${code(byRoot('pr', ['writer'])[0])} in \`autofix\` mode`), 'README per-command preflight sentence');
  const issuePreflight = section(read('skills/closed-loop-issue/SKILL.md'), '## Preflight (CL-D22, CL-D5)', 'Issue root');
  for (const name of issuePre) expect(issuePreflight.includes(code(name)), `Issue root preflight names ${name}`);
  const prPreflight = section(read('skills/closed-loop-pr/SKILL.md'), '## Preflight (CL-D22, CL-D5)', 'PR root');
  for (const name of [...prPre, ...byRoot('pr', ['writer'])]) expect(prPreflight.includes(code(name)), `PR root preflight names ${name}`);
  const resolution = section(read('skills/closed-loop-shared/references/gate-contract.md'), '## Name-level agent resolution (CL-D22, CL-D5, CL-D59)', 'shared resolution');
  for (const role of ROLES) expect(resolution.includes(code(role.name)), `shared resolution names ${role.name}`);
  // CONV-113-SURFACE-COVERAGE-001: the README role paragraph and the helper-map rows derive too.
  const canonical = ROLES.filter((role) => role.alias).map((role) => role.name), preliminary = ROLES.filter((role) => role.kind === 'preliminary').map((role) => role.name);
  expect(readme.includes(`The closed-loop workflow uses ${NUMBER_WORDS[ROLES.length]} roles: ${canonical.map(code).join(', ')}, and the non-authoritative ${code(preliminary[0])} (CL-D62).`), 'README role paragraph derives from the source');
  const prDisplay = VOCAB.gateOrder.pr.map(display);
  const autofix = read('skills/closed-loop-pr/references/autofix.md');
  expect(autofix.includes(`| Snapshot refresh — before each ${prDisplay.join('/')} invocation, before the first reply`), 'helper map snapshot row derives from the PR gate order');
  expect(autofix.includes(`| Every ${prDisplay[0]}, ${prDisplay[1]}, or ${prDisplay[2]} result, before it is read as a verdict (CL-D36, CL-D62) | \`gate_result_validate\` |`), 'helper map validate row derives from the PR gate order');
  return gaps;
}

// ADV-113-GATE-ORDER-EXACTNESS-001: each order surface is compared as a complete ordered list, never as
// a subsequence. Every role token in the block, every "<Nickname> MERGE" step, and every flow label is
// extracted and must equal the vocabulary-derived sequence exactly, so a wrong-root, duplicated,
// reordered, or missing stage is named with the full found and declared lists.
function gateOrderGaps(read) {
  const { gaps, expect, section, exact } = collector();
  const authoritative = (root) => VOCAB.gateOrder[root].filter((gate) => ROLES.find((role) => role.gate === gate).kind === 'reviewer');
  const merges = (text) => [...text.matchAll(/→ ([A-Z][a-z]+) MERGE(?=\n|$| )/g)].map((match) => match[1]);
  const loop = section(read('skills/closed-loop-pr/references/review-only.md'), '## Gate loop (PR review-only baseline; AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)', 'review-only order block');
  const fenced = loop.match(/```text\n([\s\S]*?)```/);
  expect(fenced, 'review-only order block: the fenced sequence exists');
  const block = fenced ? fenced[1] : '';
  exact(block.match(ROLE_TOKEN) || [], VOCAB.gateOrder.pr.map(roleOf), 'review-only order block stage roles');
  exact(merges(block), authoritative('pr').map(display), 'review-only order block MERGE steps');
  const legacy = read('skills/closed-loop-issue/SKILL.md').split('\n').find((line) => line.startsWith('specification → '));
  expect(legacy, 'the Issue legacy sequence line exists');
  exact((legacy ?? '').match(ROLE_TOKEN) || [], VOCAB.gateOrder.issue.map(roleOf), 'Issue legacy sequence stage roles');
  exact(merges(legacy ?? ''), authoritative('issue').map(display), 'Issue legacy sequence MERGE steps');
  const flow = read('skills/closed-loop-pr/references/autofix-addendum.md');
  exact([...flow.matchAll(/^([A-Z_]+): /gm)].map((match) => match[1]), [...VOCAB.gateOrder.pr.map((gate) => display(gate).toUpperCase()), 'FINAL_CHECK'], 'exact-autofix flow labels');
  const shared = section(read('skills/closed-loop-shared/references/gate-contract.md'), '## Convergence stage (CL-D62)', 'shared convergence section');
  expect(shared.includes(`Issue \`${VOCAB.gateOrder.issue.join(' → ')}\`, PR \`${VOCAB.gateOrder.pr.join(' → ')}\``), 'shared order sentence derives from the source');
  return gaps;
}

// ADV-113-STATUS-BLOCK-SCOPE-001: the status lines are required inside the one declared fenced
// tidd-status block of each root, compared line for line; a file with no block or more than one is a
// gap by itself and its lines are not guessed at. The restart phrase is prose and stays a file literal.
function statusGaps(read) {
  const { gaps, expect } = collector();
  for (const [root, file] of [['issue', 'skills/closed-loop-issue/SKILL.md'], ['pr', 'skills/closed-loop-pr/references/review-only.md']]) {
    const blocks = [...read(file).matchAll(/^```tidd-status\n([\s\S]*?)^```$/gm)].map((match) => match[1].split('\n'));
    expect(blocks.length === 1, `${file} declares exactly one tidd-status block: found ${blocks.length}`);
    if (blocks.length !== 1) continue;
    for (const line of [VOCAB.statusLines.rounds, VOCAB.statusLines.resolved, VOCAB.statusLines.activeGate[root]]) expect(blocks[0].includes(line), `${file} tidd-status block carries: ${line}`);
  }
  for (const file of ['README.md', 'skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/references/autofix-addendum.md']) expect(read(file).includes(VOCAB.restart), `${file} uses the declared restart phrase`);
  return gaps;
}

// CONV-113-VOCAB-CROSSCHECK (convergence, PR #113): acceptance criterion 1 also requires the role and
// gate literals that older fixtures and manifest clauses carry to be cross-checked against the source.
// Each check below is a literal on a declared line of a declared file, never a rewrite of that fixture.
function fixtureGaps(read) {
  const { gaps, expect, same } = collector();
  const rolesFixture = read('test/issue-100-tidd-roles.test.js');
  for (const role of ROLES) {
    const alias = role.alias === undefined ? 'undefined' : `'${role.alias}'`;
    expect(rolesFixture.includes(`'${role.name}': { alias: ${alias}, model: '${role.model}', writer: ${role.kind === 'writer'}, context: '${role.context}' }`), `issue-100 ROLES entry for ${role.name}`);
  }
  const packageTest = read('test/package.test.js');
  for (const role of ROLES) expect(packageTest.includes(`'${role.name}': '${role.model}',`), `package.test EXPECTED_AGENTS entry for ${role.name}`);
  const agentTools = read('test/issue-49-agent-tools.test.js');
  for (const role of ROLES) expect(agentTools.includes(`'${role.name}'`), `issue-49 lists ${role.name}`);
  const gateIds = read('test/issue-100-gate-ids-v2.test.js');
  expect(gateIds.includes(`const V2_GATES = [${quoted(VOCAB.gateIdentities)}];`), 'issue-100-gate-ids-v2 V2_GATES equals the declared identities');
  // Convergence lead on PR #113 and CONV-113-V1-MARKER-FIXTURE-001: the version 1 window's gates and the
  // marker's gate vocabulary are declared in the source, and the one fixture that names them carries
  // exactly the declared lists.
  expect(gateIds.includes(`const V1_GATES = [${quoted(VOCAB.version1Window.gates)}];`), 'issue-100-gate-ids-v2 V1_GATES equals the declared window gates');
  expect(gateIds.includes(`const MARKER_GATES = [${quoted(VOCAB.version1Window.markerGates)}];`), 'issue-100-gate-ids-v2 MARKER_GATES equals the declared marker gate vocabulary');
  const convergence = read('test/issue-101-convergence-stage.test.js');
  expect(convergence.includes(`[${quoted(VOCAB.gateIdentities)}]`), 'issue-101 pins the declared identity list');
  expect(convergence.includes(`Issue \`${VOCAB.gateOrder.issue.join(' → ')}\`, PR \`${VOCAB.gateOrder.pr.join(' → ')}\``), 'issue-101 pins the declared gate order');
  expect(convergence.includes(`${VOCAB.prefixes.convergence}-101-`), 'issue-101 uses the declared convergence namespace');
  const manifest = JSON.parse(read('test/contract-clauses.json'));
  const requires = (id) => { const clause = manifest.clauses.find((candidate) => candidate.id === id); expect(clause, `manifest clause ${id}`); return clause ? clause.requires : []; };
  const canonical = ROLES.filter((role) => role.alias).map((role) => role.name);
  expect(requires('CL-D59-resolution').includes(list(canonical)), 'CL-D59-resolution names the four CL-D59 roles from the source');
  const formalPrefixes = VOCAB.gateIdentities.filter((gate) => gate !== 'convergence').map((gate) => `\`${VOCAB.prefixes[gate]}-<n>-\``);
  expect(requires('CL-D60-identities').includes(`the derived fresh-finding namespaces are ${formalPrefixes[0]}, ${formalPrefixes[1]}, and ${formalPrefixes[2]}`), 'CL-D60-identities names the derived namespaces from the source');
  expect(requires('CL-D60-identities').includes(`Gate identities (CL-D60): under envelope schema version 2 the gate is \`${VOCAB.gateIdentities[0]}\``), 'CL-D60-identities starts with the first declared identity');
  expect(requires('CL-D62-shared').includes('the sequence restarts at convergence'), 'CL-D62-shared names the convergence restart');
  for (const id of ['CL-D62-issue', 'CL-D62-pr']) expect(requires(id).includes(VOCAB.statusLines.rounds), `${id} pins the declared rounds line`);
  expect(requires('CL-D62-autofix-flow').some((literal) => literal.startsWith(`${display('convergence').toUpperCase()}: MERGE -> ${display('adversarial').toUpperCase()};`)), 'CL-D62-autofix-flow pins the declared first flow line');
  // CONV-113-MANIFEST-CROSSCHECK-001 / CONV-113-SURFACE-COVERAGE-001: the checks are two-way. The fixture
  // constants carry exactly the declared role set, and every role-shaped token in the role/gate clauses
  // and the named fixtures is a declared role; a stale extra fails by name.
  same([...rolesFixture.matchAll(/'(tidd-[a-z-]+)': \{ alias:/g)].map((match) => match[1]).sort(), DECLARED, 'issue-100 ROLES keys are exactly the declared roles');
  same([...packageTest.matchAll(/^  '(tidd-[a-z-]+)': 'gpt-[^']+',$/gm)].map((match) => match[1]).sort(), DECLARED, 'package.test EXPECTED_AGENTS keys are exactly the declared roles');
  const reviewers = agentTools.match(/const REVIEWERS = \[([^\]]+)\]/), workers = agentTools.match(/const WORKERS = \[([^\]]+)\]/);
  expect(reviewers && workers, 'issue-49 declares REVIEWERS and WORKERS');
  if (reviewers && workers) same([...`${reviewers[1]},${workers[1]}`.matchAll(/'(tidd-[a-z-]+)'/g)].map((match) => match[1]).sort(), DECLARED, 'issue-49 REVIEWERS plus WORKERS are exactly the declared roles');
  const roleClauses = manifest.clauses.filter((clause) => ['CL-D59', 'CL-D60', 'CL-D62', 'CL-D63'].includes(clause.marker));
  expect(roleClauses.length >= 10, 'the role and gate clauses are present');
  const gateWords = new Set([...VOCAB.gateIdentities, ...VOCAB.version1Window.gates]);
  for (const clause of roleClauses) for (const literal of clause.requires) {
    for (const token of literal.match(ROLE_TOKEN) || []) expect(DECLARED.includes(token), `${clause.id}: undeclared role ${token}`);
    for (const match of literal.matchAll(/`(adversarial|decision-drift|safety|convergence|sol|terra)`/g)) expect(gateWords.has(match[1]), `${clause.id}: undeclared gate ${match[1]}`);
  }
  for (const file of [...proseFiles(), 'test/contract-clauses.json', 'test/issue-100-tidd-roles.test.js', 'test/issue-101-convergence-stage.test.js', 'test/issue-49-agent-tools.test.js', 'test/package.test.js', 'test/issue-100-gate-ids-v2.test.js']) {
    for (const token of new Set(read(file).match(ROLE_TOKEN) || [])) expect(DECLARED.includes(token), `${file}: undeclared role ${token}`);
  }
  return gaps;
}

test('Issue #110 the vocabulary source matches the packaged agents and the envelope schema', () => {
  assert.equal(VOCAB.schemaVersion, 1);
  const files = fs.readdirSync(repoPath('agents')).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(files, ROLES.map((role) => `${role.name}.md`).sort(), 'agents/ is exactly the declared role set');
  assertNoGaps(agentGaps(readText), 'agent frontmatter drifts from the source');
  assert.deepEqual(gateResult.SCHEMA.properties.correlation.properties.gate.enum, VOCAB.gateIdentities, 'the shipping schema carries exactly the declared gate identities');
  assert.deepEqual(ROLES.filter((role) => role.gate).map((role) => role.gate).sort(), [...VOCAB.gateIdentities].sort(), 'every gate identity belongs to one role');
  const { gaps, expect } = collector();
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
    expect(result.ok === true, `${gate}: the declared prefix ${VOCAB.prefixes[gate]} is the derived namespace: ${JSON.stringify(result.error ?? {})}`);
  }
  assertNoGaps(gaps, 'declared prefixes are not the shipping namespaces');
});

test('Issue #110 every declared role surface derives from the source', () => {
  assertNoGaps(roleSurfaceGaps(readText), 'role surfaces drift from the source');
});

test('Issue #110 every declared gate-order surface follows the source order', () => {
  assertNoGaps(gateOrderGaps(readText), 'gate-order surfaces drift from the source');
});

test('Issue #110 status grammar lines derive from the source', () => {
  assertNoGaps(statusGaps(readText), 'status and restart surfaces drift from the source');
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
  assertNoGaps(offenders, 'retired phrases survive');
  assertNoGaps(VOCAB.retiredPhrases.filter((retired) => !/^CL-D\d+$/.test(retired.retiredBy)).map((retired) => `/${retired.pattern}/ names ${retired.retiredBy}`), 'every denylist entry names the decision that retired it');
});

test('Issue #110 the Sol-only payload block pre-checks derived surfaces and CL-D63 records the layer', () => {
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(block);
  assert.match(block, /When the target repository pins surfaces by derived-vocabulary and retired-phrase tests, those surfaces are pre-checked deterministically: do not re-raise a surface-agreement gap they cover as a finding/);
  assert.match(block, /when a surface-agreement gap is found on a surface they do not cover, enumerate every instance across the target in one result rather than one per round \(CL-D63\)/);
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D63 — Deterministic agreement checks are the first review layer');
  assert.ok(record, 'CL-D63 must exist');
  assertNoGaps(['*Decision ID:* CL-D63', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*'].filter((field) => !record.includes(field)), 'CL-D63 lacks record fields');
  assert.match(record, /issues\/110/);
  assert.match(record, /validate declared surfaces with literals derived from one source; never classify prose/);
  assert.match(record, /a denylist entry is added only when a decision retires a phrase/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D63').map((clause) => clause.id).sort(), ['CL-D63-payload', 'CL-D63-tests']);
});

test('Issue #110 existing role and gate fixtures cross-check the source', () => {
  assertNoGaps(fixtureGaps(readText), 'fixtures and manifest clauses drift from the source');
});

// Convergence lead on PR #113 (non-authoritative): the version 1 window's gates, prefixes, and the
// marker's gate vocabulary were outside the source. They are declared now and checked against the
// shipping code; the fixture that names them is cross-checked in fixtureGaps.
test('Issue #110 the version 1 window and the marker gate vocabulary derive from the source', () => {
  const helpers = require('../skills/closed-loop-pr/helpers');
  const window = VOCAB.version1Window;
  assert.deepEqual(gateResult.SCHEMAS[1].properties.correlation.properties.gate.enum, window.gates, 'the version 1 schema carries exactly the declared window gates');
  const { gaps, expect } = collector();
  for (const gate of window.gates) {
    const findingId = `${window.prefixes[gate]}-110-WINDOW`;
    const correlation = { repository: 'o/r', number: 110, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
    const finding = { findingId, origin: 'fresh', gate, headOid: OID, raisedAgainstFingerprint: SHA, severity: 'Minor', anchoring: 'criterion-anchored', anchor: 'AC', proposedDisposition: 'fixed', evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending', workflowRecord: { sourceKind: 'gate', sourceId: findingId, authorIdentity: 'x', authorType: 'Agent', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'c' } };
    const envelope = { schemaVersion: 1, correlation, verdict: 'FIX BEFORE MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }], findings: [finding], confirmations: [], decisions: [], adversarialResults: gate === 'sol' ? [{ claim: 'c', searched: 's', outcome: 'counterexample', evidence: 'e', findingId }] : [] };
    const result = gateResult.validateGateResult(envelope, { workflow: 'pr', correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
    expect(result.ok === true, `${gate}: the declared window prefix is the version 1 namespace: ${JSON.stringify(result.error ?? {})}`);
  }
  const binding = (gates) => ({ repository: 'o/r', number: 110, sourceKind: 'issue_comment', sourceId: '1', sourceUrl: 'https://github.com/o/r/pull/110#issuecomment-1', sourceBodySha256: SHA, sourceCreatedAt: '2026-09-07T00:00:00Z', sourceUpdatedAt: '2026-09-07T00:00:00Z', head: OID, findings: [{ findingId: 'ADV-110-M', disposition: 'fixed' }], gates, commit: null });
  for (const gates of window.markerGates) {
    const made = helpers.createReplyMarker({ binding: binding(gates), visibleBody: 'Confirming gate.\n' });
    expect(made.ok === true, `marker gates ${gates}: ${JSON.stringify(made.error ?? {})}`);
  }
  assertNoGaps(gaps, 'the declared version 1 window is not what ships');
  assert.equal(helpers.createReplyMarker({ binding: binding('luna'), visibleBody: 'Confirming gate.\n' }).ok, false, 'an undeclared marker gate is rejected');
});

// ADV-113-EXHAUSTIVE-GAPS-001 (Sol, PR #113): every surface check collects its gaps and asserts once, so a
// single run names every location. The regression mutates eight surfaces across three collectors at the
// same time through an in-memory overlay and requires all ten gaps in one result. The README table is
// compared as an exact ordered list of role rows inside its section, the same class of check as the
// gate-order surfaces, so a stale extra row and the two removed rows are one named comparison.
// ADV-113-GATE-ORDER-EXACTNESS-001 (Sol, PR #113): two of the mutations are a declared Issue-only stage
// inserted into the PR order block and a duplicated declared stage in the Issue sequence; a subsequence
// scan accepts both, an exact ordered comparison names both.
// ADV-113-STATUS-BLOCK-SCOPE-001 (Sol, PR #113): two more are a status line relocated out of the PR
// tidd-status fence into prose below the title (the literal survives in the file) and a second
// tidd-status fence appended to the Issue root; a whole-file search accepts both, a block-scoped
// comparison names the missing line and refuses to guess between two blocks.
test('Issue #110 one run names every simultaneous surface gap', () => {
  const overlay = new Map();
  overlay.set('README.md', readText('README.md').split('\n').filter((line) => !/^\| `tidd-(?:drift|safety)-reviewer` \|/.test(line)).join('\n').replace('\n| --- | --- | --- |\n', '\n| --- | --- | --- |\n| `tidd-legacy-reviewer` | `gpt-5.6-legacy` | stale |\n'));
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  overlay.set('skills/closed-loop-pr/references/review-only.md', reviewOnly.replace(`\n${VOCAB.statusLines.resolved}\n`, '\n').replace(`\n${VOCAB.statusLines.rounds}\n`, '\n').replace('\n\n', `\n\n${VOCAB.statusLines.rounds}\n\n`).replace('\n→ tidd-safety-reviewer gate\n', '\n→ tidd-drift-reviewer gate\n→ tidd-safety-reviewer gate\n'));
  const issueSkill = readText('skills/closed-loop-issue/SKILL.md');
  overlay.set('skills/closed-loop-issue/SKILL.md', `${issueSkill.replace(/^(specification → .*)$/m, '$1 → tidd-adversarial-reviewer gate')}\n${issueSkill.match(/```tidd-status\n[\s\S]*?```\n/)[0]}`);
  overlay.set('test/package.test.js', `${readText('test/package.test.js')}\n  'tidd-legacy-reviewer': 'gpt-5.6-legacy',\n`);
  const read = withOverlay(overlay);
  for (const [file, text] of overlay) assert.notEqual(text, readText(file), `${file}: the mutation must change the surface`);
  assert.ok(overlay.get('skills/closed-loop-pr/references/review-only.md').includes(`\n${VOCAB.statusLines.rounds}\n`), 'the relocated rounds line survives in the file outside its block');
  const gaps = [...roleSurfaceGaps(read), ...gateOrderGaps(read), ...statusGaps(read), ...fixtureGaps(read)];
  const prRoles = VOCAB.gateOrder.pr.map(roleOf), issueRoles = VOCAB.gateOrder.issue.map(roleOf);
  assert.deepEqual(gaps.sort(), [
    `README Included agents rows: found ${['`tidd-legacy-reviewer` | `gpt-5.6-legacy`', ...ROLES.filter((role) => !['tidd-drift-reviewer', 'tidd-safety-reviewer'].includes(role.name)).map((role) => `${code(role.name)} | ${code(role.model)}`)].join(', ')}; declared ${ROLES.map((role) => `${code(role.name)} | ${code(role.model)}`).join(', ')}`,
    'README.md: undeclared role tidd-legacy-reviewer',
    `review-only order block stage roles: found ${[prRoles[0], prRoles[1], 'tidd-drift-reviewer', prRoles[2]].join(', ')}; declared ${prRoles.join(', ')}`,
    `Issue legacy sequence stage roles: found ${[...issueRoles, 'tidd-adversarial-reviewer'].join(', ')}; declared ${issueRoles.join(', ')}`,
    `package.test EXPECTED_AGENTS keys are exactly the declared roles: extra tidd-legacy-reviewer`,
    `skills/closed-loop-pr/references/review-only.md tidd-status block carries: ${VOCAB.statusLines.resolved}`,
    `skills/closed-loop-pr/references/review-only.md tidd-status block carries: ${VOCAB.statusLines.rounds}`,
    'skills/closed-loop-issue/SKILL.md declares exactly one tidd-status block: found 2',
    'test/package.test.js: undeclared role tidd-legacy-reviewer',
  ].sort());
});

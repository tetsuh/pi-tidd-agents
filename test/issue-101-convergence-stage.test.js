'use strict';

// Issue #101 (CL-D62) — a non-authoritative convergence stage runs once per candidate identity and
// snapshot fingerprint (DEC-109-CONV-SNAPSHOT-001)
// before the adversarial gate on both roots, so ordinary omissions are found and corrected
// before the expensive formal gates run. It returns the CL-D36 envelope with gate `convergence`
// and namespace `CONV-`, its findings reach Sol as assigned findings, its rounds are accounted
// separately, exhaustion hands the candidate to Sol, and no convergence outcome can declare
// readiness. Owner decisions: issues/101#issuecomment-5541436767 (all five as recommended).
//
// TDD provenance: recorded with `node --test test/issue-101-convergence-stage.test.js` at RED
// before the role file, the gate identity, the prose, and the record existed. That local output
// is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const gateResult = require('../skills/closed-loop-pr/helpers/gate-result');
const { readText, sectionOf, parseFrontmatter, exists } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const OID = 'a'.repeat(40);
const SHA = '1'.repeat(64);
const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}
function correlation(gate) {
  return {
    repository: 'tetsuh/pi-tidd-agents', number: 101, baseOid: 'b'.repeat(40),
    headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'feat/issue-101-convergence-stage',
    headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1,
    contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64),
  };
}
function envelope(gate, over = {}) {
  return {
    schemaVersion: 2, correlation: correlation(gate), verdict: 'MERGE',
    evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA, readCompletely: true }],
    findings: [], confirmations: [], decisions: [], adversarialResults: [],
    ...over,
  };
}
function expectation(workflow, gate) {
  return { workflow, correlation: correlation(gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] };
}
function fresh(findingId, root) {
  return {
    findingId, origin: 'fresh', gate: 'convergence', headOid: OID, raisedAgainstFingerprint: SHA,
    severity: 'Minor', anchoring: 'criterion-anchored', anchor: 'AC-TESTS', proposedDisposition: 'fixed',
    evidence: 'e', impact: 'i', rationale: 'r', correction: 'c', transport: 'pending',
    workflowRecord: root === 'pr'
      ? { sourceKind: 'gate', sourceId: findingId, authorIdentity: 'tidd-convergence-reviewer', authorType: 'Agent', observedHeadOid: OID, fingerprint: SHA, semanticFingerprint: SHA, correctiveChange: 'narrowed' }
      : { candidateIdentity: 'candidate-1', revisedPassage: 'revised', snapshotAssignment: 'snapshot-1' },
  };
}
const decision = () => ({
  decisionId: 'DEC-101-001', kind: 'contract', targetAndRevision: 'Issue #101 at head', question: 'q',
  options: 'a or b', recommendation: 'a', rationale: 'r', validity: 'this revision', status: 'pending',
});

test('Issue #101 the package ships the convergence role as a read-only, fresh-context, non-authoritative reviewer', () => {
  assert.ok(exists('agents/tidd-convergence-reviewer.md'), 'the role file must exist');
  const text = readText('agents/tidd-convergence-reviewer.md');
  const frontmatter = parseFrontmatter(text);
  assert.equal(frontmatter.name, 'tidd-convergence-reviewer');
  assert.equal(frontmatter.aliases, undefined, 'a new role carries no transitional alias');
  assert.equal(frontmatter.model, 'gpt-5.6-luna', 'owner decision 1: the shipped default is Luna');
  assert.equal(String(frontmatter.thinking).replace(/"/g, ''), 'high');
  assert.equal(frontmatter.defaultContext, 'fresh');
  assert.equal(String(frontmatter.inheritSkills), 'false');
  assert.deepEqual(frontmatter.tools.split(',').map((tool) => tool.trim()), REVIEWER_TOOLS);
  assert.doesNotMatch(frontmatter.description, /gpt|glm|powered by|\bsol\b|\bterra\b|\bluna\b/i, 'the description names the responsibility, never the model');
  assert.match(frontmatter.description, /preliminary/i);
  const body = text.slice(text.indexOf('---', 3) + 3);
  assert.match(body, /never declare `IMPLEMENTATION_READY` or `MERGE_READY`/);
  assert.match(body, /You run once per candidate identity and snapshot fingerprint before the formal adversarial gate/);
  assert.match(body, /MERGE \| FIX BEFORE MERGE \| NEEDS DECISION/);
  assert.match(body, /You never apply fixes/);
});

test('Issue #101 the envelope accepts the convergence gate on both roots with its own namespace and no adversarial duty', () => {
  for (const root of ['pr', 'issue']) {
    const clean = gateResult.validateGateResult(envelope('convergence'), expectation(root, 'convergence'));
    assert.equal(clean.ok, true, `${root}: ${JSON.stringify(clean.error ?? {})}`);
    const findings = gateResult.validateGateResult(envelope('convergence', { verdict: 'FIX BEFORE MERGE', findings: [fresh('CONV-101-OMISSION', root)] }), expectation(root, 'convergence'));
    assert.equal(findings.ok, true, `${root} findings: ${JSON.stringify(findings.error ?? {})}`);
    const wrongNamespace = gateResult.validateGateResult(envelope('convergence', { verdict: 'FIX BEFORE MERGE', findings: [fresh('ADV-101-OMISSION', root)] }), expectation(root, 'convergence'));
    assert.equal(wrongNamespace.error.code, 'finding_records_invalid', `${root}: a convergence finding under the adversarial namespace is a record error`);
    // Owner decision 4: a NEEDS DECISION verdict takes the ordinary owner-decision path.
    const needs = gateResult.validateGateResult(envelope('convergence', { verdict: 'NEEDS DECISION', decisions: [decision()] }), expectation(root, 'convergence'));
    assert.equal(needs.ok, true, `${root} decision: ${JSON.stringify(needs.error ?? {})}`);
    // Malformed output is a tool failure in the boundary's vocabulary, never a verdict.
    const malformed = gateResult.validateGateResult({ ...envelope('convergence'), verdict: undefined }, expectation(root, 'convergence'));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, 'schema_invalid');
  }
  // The adversarial-results duty stays with the adversarial gate; version 1 knows no convergence.
  assert.equal(gateResult.validateGateResult(envelope('adversarial'), expectation('pr', 'adversarial')).error.code, 'evidence_records_invalid');
  assert.equal(gateResult.validateGateResult({ ...envelope('convergence'), schemaVersion: 1 }, expectation('pr', 'convergence')).error.code, 'unknown_enum');
  assert.deepEqual(gateResult.SCHEMA.properties.correlation.properties.gate.enum, ['adversarial', 'decision-drift', 'safety', 'convergence']);
  const built = cli('build_gate_expectation', expectation('issue', 'convergence'));
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.ok(built.data.outputSchema.properties.correlation.properties.gate.enum.includes('convergence'));
  const marker = helpers.createReplyMarker({
    binding: {
      repository: 'tetsuh/pi-tidd-agents', number: 101, sourceKind: 'issue_comment', sourceId: '1',
      sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/101#issuecomment-1', sourceBodySha256: SHA,
      sourceCreatedAt: '2026-09-04T00:00:00Z', sourceUpdatedAt: '2026-09-04T00:00:00Z', head: OID,
      findings: [{ findingId: 'CONV-101-OMISSION', disposition: 'fixed' }], gates: 'convergence', commit: null,
    },
    visibleBody: 'Confirming gate: convergence at the exact head.\n',
  });
  assert.equal(marker.ok, true, JSON.stringify(marker.error ?? {}));
});

test('Issue #101 the shared contract defines the stage: order, one per candidate and snapshot, caps, hand-over, invalidation, disabled skip, telemetry', () => {
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  const section = sectionOf(contract, '## Convergence stage (CL-D62)');
  assert.ok(section, 'the shared contract must carry the convergence section');
  // DEC-109-CONV-SNAPSHOT-001 (Option B): attempts are keyed by candidate identity and snapshot fingerprint.
  assert.match(section, /read-only, fresh-context, non-authoritative preliminary reviewer that runs once per candidate identity and snapshot fingerprint before the adversarial gate on both roots/);
  assert.match(section, /new snapshot evidence on an unchanged head reruns convergence before Sol within the same cap/);
  assert.match(section, /Issue `convergence → adversarial → decision-drift`, PR `convergence → adversarial → safety`/);
  assert.match(section, /gate `convergence` and the derived namespace `CONV-<n>-`/);
  assert.match(section, /reach the adversarial gate as assigned findings/);
  assert.match(section, /no convergence outcome can declare `IMPLEMENTATION_READY` or `MERGE_READY`/);
  assert.match(section, /invalidates convergence results exactly as it invalidates formal results, and the sequence restarts at convergence/);
  assert.match(section, /accounted separately as `convergence <used>\/<cap>`, never against a formal gate's budget/);
  assert.match(section, /the cap is 3 per run on the Issue root and PR review-only and 5 on exact autofix/);
  assert.match(section, /hands the current candidate to the adversarial gate with those findings assigned and does not invoke convergence again; `ROUND_LIMIT_REACHED` remains reserved for the formal gates/);
  assert.match(section, /A `NEEDS DECISION` verdict from convergence takes the ordinary owner-decision path/);
  assert.match(section, /the stage is skipped and the status block reports `convergence: disabled`/);
  assert.match(section, /present but unresolved or resolves with `edit` or `write` is `BLOCKED`/);
  assert.match(section, /reports `resolved:` with the provider, model, and thinking level each role ran with/);
  // ADV-109-CONVERGENCE-NO-PROGRESS-OMITTED: the no-progress circuit breaker counts convergence observations.
  assert.match(section, /The no-progress rule is shared: a convergence result's unresolved observation of an assigned `blockerKey × breakerOwner` counts toward that key's history exactly as a formal result's does, at most one per result, and the third observation across convergence and formal gates stops the run/);
  const resolution = sectionOf(contract, '## Name-level agent resolution (CL-D22, CL-D5, CL-D59)');
  assert.match(resolution, /plus the non-authoritative preliminary `tidd-convergence-reviewer` \(CL-D62\)/);
  assert.match(resolution, /a disabled `tidd-convergence-reviewer` skips its stage \(CL-D62\)/);
  const transport = sectionOf(contract, '### Structured gate result transport (CL-D36)');
  assert.match(transport, /or `convergence` \(the non-authoritative preliminary stage on both roots, CL-D62\)/);
  assert.match(transport, /`CONV-<n>-` for convergence/);
});

test('Issue #101 both roots run convergence before the adversarial gate and report it in the status block', () => {
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  assert.match(issue, /`tidd-convergence-reviewer` runs the CL-D62 convergence stage when it resolves and is skipped when disabled/);
  // SOL-109-ISSUE-FIXED-ORDER-OMITS-CONVERGENCE: the legacy sequence and its order sentence start at convergence.
  assert.match(issue, /specification → tidd-convergence-reviewer stage \(non-authoritative, CL-D62\) → preliminary disposition\/revision → tidd-adversarial-reviewer gate → disposition\/revision → Sol MERGE/);
  assert.match(issue, /The fixed review order is convergence first, then Sol-before-Terra\./);
  assert.match(issue, /`tidd-convergence-reviewer` first runs the non-authoritative convergence stage \(CL-D62\) once per candidate identity and snapshot fingerprint; its findings reach Sol as assigned findings and it never authorizes readiness/);
  assert.match(issue, /the convergence stage reviews the complete unchanged object once \(CL-D62\), Sol reviews the complete unchanged object/);
  assert.match(issue, /restarts at convergence, then Sol/);
  // ADV-109-CLD32-POST-DECISION-OMITS-CONVERGENCE: the CL-D32 combined-decision route and the
  // candidate-phase identity allocation include convergence; the pinned CL-D32 phrases survive.
  assert.match(issue, /grants no mutation before the mandatory unchanged convergence review and the mandatory unchanged Sol then Terra sequence/);
  assert.match(issue, /After the exact affirmative response, convergence reviews the unchanged decision-containing candidate first \(CL-D62\); Sol must re-review the unchanged candidate containing the decision, and Terra starts only after Sol returns `MERGE`/);
  assert.match(issue, /before every physical convergence, Sol, or Terra launch/);
  assert.match(issue, /mandatory unchanged convergence review, then mandatory unchanged Sol then Terra review, follows the exact affirmative response/);
  assert.match(issue, /once its unchanged convergence stage has run and its unchanged Sol and Terra gates match/);
  assert.doesNotMatch(issue, /before every physical Sol or Terra launch/);
  assert.match(issue, /active_gate: <convergence\|sol\|terra\|none>/);
  assert.match(issue, /rounds: convergence <used>\/3, sol <used>\/3, terra <used>\/3/);
  assert.match(issue, /resolved: <role provider\/model:thinking, one per role that ran; convergence: disabled when skipped>/);
  const pr = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(pr, /`tidd-convergence-reviewer` runs the CL-D62 convergence stage in both modes when it resolves and is skipped when disabled/);
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /→ tidd-convergence-reviewer stage \(non-authoritative, CL-D62\)\n→ preliminary disposition \(a `FIX BEFORE MERGE` stops at `WAITING_FOR_OWNER` before Sol\)\n→ tidd-adversarial-reviewer gate/);
  assert.match(reviewOnly, /a preliminary `FIX BEFORE MERGE` is reported through the disposition\/draft path as `WAITING_FOR_OWNER` before Sol runs, and open convergence findings are assigned to Sol/);
  assert.match(reviewOnly, /Convergence rounds are accounted separately as `convergence <used>\/3`, one per candidate identity and snapshot fingerprint; at the cap the candidate goes to Sol with open convergence findings assigned \(CL-D62\)/);
  assert.match(reviewOnly, /runs first, once per candidate identity and snapshot fingerprint, as the non-authoritative CL-D62 stage/);
  assert.match(reviewOnly, /active_gate: <convergence\|sol\|terra\|external\|none>/);
  assert.match(reviewOnly, /rounds: convergence <used>\/3, sol <used>\/3, terra <used>\/3/);
  assert.match(reviewOnly, /resolved: <role provider\/model:thinking, one per role that ran; convergence: disabled when skipped>/);
  assert.match(reviewOnly, /\*\*Never start the Terra gate before the Sol gate returns `MERGE`\.\*\*/);
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.match(addendum, /The CL-D62 convergence stage runs once per candidate identity and snapshot fingerprint before each Sol invocation, is accounted separately as `convergence <used>\/5` outside the 15 counted gate invocations, and at its cap hands the candidate to Sol with open convergence findings assigned/);
  assert.match(addendum, /the final summary reports `resolved:` with each role's provider, model, and thinking level/);
  assert.match(addendum, /the convergence stage's payload and result are bound the same way \(CL-D62\)/);
  assert.match(addendum, /a convergence result that observes an assigned blocker unresolved counts toward that key's history whatever its `breakerOwner`, at most one observation per result, while convergence stays outside the 15 counted invocations \(CL-D62\)/);
  assert.doesNotMatch(addendum, /Sol-owned blockers count only in Sol results/);
  // ADV-109-EXACT-AUTOFIX-MAP-OMITS-CONVERGENCE: the canonical flow starts at convergence and every
  // correction or same-head evidence route returns there; the helper map rows cover convergence.
  assert.match(addendum, /^CONVERGENCE: MERGE -> SOL; FIX -> LUNA_CORRECT_VALIDATE_COMMIT_PUSH -> CONVERGENCE; CAP -> SOL \(open findings assigned\); DECISION\/FAILURE -> STOP$/m);
  assert.match(addendum, /^SOL:   MERGE -> TERRA; FIX -> LUNA_CORRECT_VALIDATE_COMMIT_PUSH -> CONVERGENCE; DECISION\/FAILURE\/LIMIT -> STOP$/m);
  assert.match(addendum, /^TERRA: MERGE -> FINAL_CHECK; FIX -> LUNA_CORRECT_VALIDATE_COMMIT_PUSH -> CONVERGENCE; DECISION\/FAILURE\/LIMIT -> STOP$/m);
  assert.match(addendum, /^FINAL_CHECK: new actionable evidence -> CONVERGENCE; missing\/pending\/failed policy -> STOP; stable evidence -> replies -> MERGE_READY$/m);
  assert.match(addendum, /Convergence runs first, then Sol, and Terra starts only after Sol returns `MERGE` for the exact current public head/);
  assert.doesNotMatch(addendum, /LUNA_CORRECT_VALIDATE_COMMIT_PUSH -> SOL;|new actionable evidence -> SOL;/, 'no route may return directly to Sol');
  const autofix = readText('skills/closed-loop-pr/references/autofix.md');
  assert.match(autofix, /\| Snapshot refresh — before each convergence\/Sol\/Terra invocation, before the first reply, each reply batch, final classification, post-reply, summary mutation \| `snapshot` \|/);
  assert.match(autofix, /\| Every convergence, Sol, or Terra result, before it is read as a verdict \(CL-D36, CL-D62\) \| `gate_result_validate` \|/);
  assert.doesNotMatch(autofix, /before each Sol\/Terra invocation|Every Sol or Terra result/, 'no helper boundary may name only Sol and Terra');
  assert.match(addendum, /New evidence on the same public head also reruns the convergence stage before Sol, keyed by head and snapshot fingerprint within its cap of five \(CL-D62, DEC-109-CONV-SNAPSHOT-001\)/);
  assert.match(addendum, /gate \(`adversarial`, `safety`, or `convergence`; `sol` or `terra` under schema version 1\)/);
});

test('Issue #101 the README documents the role, its default, the self-review caveat, and the design rule', () => {
  const readme = readText('README.md');
  assert.match(readme, /\| Preliminary convergence review inside the closed loop \(non-authoritative\) \| `tidd-convergence-reviewer` \|/);
  assert.match(readme, /`tidd-convergence-reviewer` \(CL-D62\) is the non-authoritative preliminary reviewer that runs before the adversarial gate/);
  assert.match(readme, /ships with the `gpt-5.6-luna` default/);
  assert.match(readme, /In exact autofix its default reviews the writer's own patch, which is model-level self-review; independent patch review is tracked in #102/);
  assert.match(readme, /Disable the agent through pi-subagents configuration to skip the stage/);
  assert.match(readme, /runs before the adversarial gate on both roots, once per candidate identity and snapshot fingerprint, with its own round budget/);
  // Included agents and Model overrides inventories name the fifth role.
  assert.match(readme, /\| `tidd-convergence-reviewer` \| `gpt-5.6-luna` \| Read-only preliminary convergence review before the formal gates \(non-authoritative\) \|/);
  assert.match(readme, /Overrides are keyed by role name, for all five roles including `tidd-convergence-reviewer`/);
  assert.match(readme, /- The convergence reviewer uses fresh context and is never readiness authority\./);
  // SOL-109-README-INVENTORIES-OMIT-CONVERGENCE: the exhaustive inventories count the fifth role and the fourth identity.
  assert.match(readme, /Composes a fixed set of five agents: four formal roles plus the non-authoritative convergence reviewer\./);
  assert.match(readme, /The closed-loop workflow uses five roles: `tidd-adversarial-reviewer`, `tidd-drift-reviewer`, `tidd-safety-reviewer`, `tidd-autofix-worker`, and the non-authoritative `tidd-convergence-reviewer`/);
  assert.match(readme, /plus the non-authoritative `convergence` \(CL-D62\), with fresh-finding prefixes `ADV-`, `DRIFT-`, `SAFETY-`, and `CONV-`/);
  assert.doesNotMatch(readme, /uses four roles/);
  // ADV-109-README-RESTARTS-AT-SOL / ADV-109-README-AUTOFIX-RESTARTS-AT-SOL (Sol envelopes at b843485 that the
  // parent failed to read): the README route summaries and both autofix restart sentences name convergence.
  assert.match(readme, /a complete candidate is reviewed by convergence, then Sol, then Terra before the Skill shows one exact frozen preview/);
  assert.match(readme, /Every push restarts at convergence, then Sol\./);
  assert.match(readme, /then a mandatory convergence review precedes the mandatory Sol rereview and Terra review, which occur in that order \(CL-D62\)/);
  assert.match(readme, /Every successful push invalidates prior approvals and restarts at convergence, then Sol\./);
  assert.doesNotMatch(readme, /restarts? at Sol\b/, 'no README route may restart at Sol');
  // ADV-109-README-PREFLIGHT-OVERRIDE-OMITS-CONVERGENCE: the per-command preflight lists and the
  // custom-definition guidance name the convergence role and the disable-to-skip rule.
  assert.match(readme, /`\/tidd-issue` preflights `tidd-adversarial-reviewer`, `tidd-drift-reviewer`, and `tidd-convergence-reviewer`; `\/tidd-pr` preflights `tidd-adversarial-reviewer`, `tidd-safety-reviewer`, and `tidd-convergence-reviewer`, and adds `tidd-autofix-worker` in `autofix` mode\. A disabled `tidd-convergence-reviewer` is not a preflight failure: its stage is skipped and the status block reports `convergence: disabled`\./);
  assert.match(readme, /defining your own `tidd-adversarial-reviewer`, `tidd-drift-reviewer`, `tidd-safety-reviewer`, `tidd-autofix-worker`, and `tidd-convergence-reviewer`, or disabling `tidd-convergence-reviewer` when no model is available for it/);
  assert.doesNotMatch(readme, /preflights `tidd-adversarial-reviewer` and `tidd-drift-reviewer`;|`tidd-safety-reviewer`, and `tidd-autofix-worker`\.\n/, 'no four-role operational inventory remains');
});

test('Issue #101 CL-D62 records the stage and widens CL-D1, CL-D22, and CL-D60', () => {
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D62 — A non-authoritative convergence stage runs before the adversarial gate');
  assert.ok(record, 'CL-D62 must exist');
  for (const field of ['*Decision ID:* CL-D62', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D62 must carry ${field}`);
  assert.match(record, /issues\/101#issuecomment-5541436767/);
  assert.match(record, /widens the CL-D1 `agents\/` freeze exactly once more/);
  assert.match(record, /`convergence` identity under CL-D60/);
  assert.match(record, /3 per run on the Issue root and PR review-only and 5 on exact autofix/);
  assert.match(record, /issues\/101#issuecomment-5549173659/);
  assert.match(record, /keyed by public head and snapshot fingerprint/);
  assert.doesNotMatch(record, /per candidate identity(?! and snapshot fingerprint)/, 'the record carries no candidate-only wording');
  assert.match(record, /the CL-D32 post-decision route runs convergence on the unchanged decision-containing candidate before Sol/);
  assert.match(record, /exact autofix's canonical flow starts at convergence and every correction or same-head evidence route returns there/);
  assert.match(record, /reference transition models in the test fixtures route every correction and every new actionable evidence through convergence before Sol/);
  assert.match(record, /convergence observations count toward the `blockerKey × breakerOwner` no-progress history/);
  // ADV-109-STALE-REFERENCE-FIXTURES-RESTART-AT-SOL: the reference models carry no direct-to-Sol restart.
  const regressions = readText('test/closed-loop-regressions.test.js');
  assert.match(regressions, /restart: 'convergence'/);
  assert.match(regressions, /observation\.gate !== 'sol' && observation\.gate !== 'convergence'/, 'the reference no-progress history counts convergence observations');
  assert.doesNotMatch(regressions, /restart: 'sol'|newActionableEvidence \? 'sol'|newActionableEvidence\) return 'sol'/);
  const candidate = readText('test/issue-candidate-publication.test.js');
  assert.match(candidate, /next: 'convergence', accepted: true/);
  assert.doesNotMatch(candidate, /return \{ rounds, next: 'sol', accepted: true \};\n  return \{ rounds, next: 'stop'/, 'a correction never returns directly to Sol');
  assert.match(sectionOf(contract, '## CL-D32 — Scope-freeze approval stays inside the candidate transaction'), /CL-D62 later placed the convergence stage before the mandatory unchanged Sol then Terra rereview/);
  assert.match(sectionOf(contract, '## CL-D1 — Gate verdicts are supplied by the caller, not by agent files'), /CL-D62 later added the convergence role file under its own widening/);
  assert.match(sectionOf(contract, '## CL-D22 — Closed-loop model requirements and preflight'), /CL-D62 later added the non-authoritative `tidd-convergence-reviewer`/);
  assert.match(sectionOf(contract, '## CL-D60 — Gate identities name workflow functions; schema version 2'), /CL-D62 later added the `convergence` identity under its own decision/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D62').map((clause) => clause.id).sort(), ['CL-D62-autofix', 'CL-D62-autofix-flow', 'CL-D62-autofix-map', 'CL-D62-issue', 'CL-D62-pr', 'CL-D62-readme', 'CL-D62-shared', 'CL-D62-tests']);
});

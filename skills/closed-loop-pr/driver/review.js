'use strict';

// CL-D93 (#196): the packaged review-only driver. It sequences one PR review round from the package's helpers in the
// order review-only.md states and leaves the parent one thing per gate: the `subagent` call it prints. Gates judge;
// the driver never does.
//
//   node review.js start  --pr N [--repo owner/name] [--issue N] [--checkout DIR] [--run-dir DIR] [--language-profile P] [--convergence disabled] [--validate JSON]
//   node review.js result --run-dir DIR --run-id ID
//   node review.js resume --run-dir DIR
//   node review.js status --run-dir DIR

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { Run, headFingerprints, targetMoved, roleLabel, checkoutProblem, ignoredInventory, ROLE, LANGUAGE_PROFILE, die, parseArgs, gh, contractInput, acceptanceCriteria, validationCommands } = require('./run');
const { gateLabel: label, bindTarget, guard, readIssue, trustedComments, isRecorded, readGate, collectSnapshotEvidence, sameSpec, finalPolicy } = require('./phases');

const GATES = ['convergence', 'adversarial', 'safety'];
const ROUND_CAP = 3;
const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
function rounds(s) { return GATES.map((g) => (g === 'convergence' && s.convergenceDisabled ? 'convergence disabled' : `${label(g)} ${s.invocations[g] || 0}/${ROUND_CAP}`)).join(', '); }

function start(opts) {
  // CL-D62: a convergence role the parent's role preflight found disabled is skipped; nothing else is accepted here.
  if (opts.convergence !== undefined && opts.convergence !== 'disabled') die('--convergence takes only the value disabled');
  const { checkout, runDir, pull, target } = bindTarget(opts, 'review');
  const run = new Run(runDir), s = run.state;
  Object.assign(s, { mode: 'review-only', checkout, startedAt: new Date().toISOString(), invocations: {}, verdicts: {}, findings: [], convergenceDisabled: opts.convergence === 'disabled', resolved: opts.convergence === 'disabled' ? ['convergence: disabled'] : [], gateLog: [], languageProfile: opts['language-profile'] || LANGUAGE_PROFILE });
  s.rounds = rounds(s);
  run.file('pr-before.json', pull);
  s.target = target;
  s.body = pull.body || '';
  s.contractInput = contractInput(CONTRACT_INPUT_FILES);
  run.save();
  guard(run);
  if (pull.state !== 'open' || pull.draft) run.stop('BLOCKED', `the pull request is ${pull.state}${pull.draft ? ' (draft)' : ''}`);
  const before = checkoutProblem(checkout, target.headOid); if (before) run.stop('BLOCKED', before);
  // The Issue this PR serves, its acceptance criteria, and the validation the base commit names; each gap stops here.
  const closes = opts.issue ? [null, String(opts.issue)] : /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(s.body);
  if (!closes) run.stop('BLOCKED', 'the PR body names no `Closes #N` issue and no --issue was given');
  s.issueNumber = Number(closes[1]);
  const { issue, comments } = readIssue(run);
  run.file('issue.json', issue); run.file('issue-comments.json', comments);
  s.acceptanceCriteria = acceptanceCriteria(issue.body);
  if (!s.acceptanceCriteria.length) run.stop('BLOCKED', `issue #${s.issueNumber} has no Acceptance criteria section with at least one criterion`);
  const validation = validationCommands(checkout, target.baseOid, { validate: opts.validate, repository: target.repository });
  s.validationSource = validation.source;
  if (validation.problem) run.stop('BLOCKED', validation.problem);
  const evidence = headFingerprints(run, { cwd: checkout, baseOid: target.baseOid, headOid: target.headOid, issue, comments });
  run.file('pr.diff', evidence.diff);
  // The gate receives the exact diff, so a diff that is not UTF-8 text stops here rather than reaching it altered.
  if (!isUtf8(Buffer.from(evidence.diff))) run.stop('BLOCKED', 'the diff is not valid UTF-8, so no gate can receive it exactly; review it on the prose path of review-only.md');
  s.fingerprints = evidence.values; s.records = evidence.records;
  const results = [`source: ${validation.source}`, ...(validation.source === 'none' ? ['no validation commands configured'] : [])];
  for (const command of [...validation.commands, ['git', 'diff', '--check', `${target.baseOid}...${target.headOid}`]]) {
    const v = run.op('validation_run', { cwd: checkout, command, timeoutMs: 1800000 }, { allowFail: true });
    results.push(`${command.join(' ')}: ${v.data?.outcome || v.error?.code}`);
    s.validation = results.join('; ');
    // A failed command is a validation result; a harness that could not run it is never a verdict (review-only.md).
    if (v.ok === false && v.error?.code !== 'validation_failed') run.stop('BLOCKED', `harness_failed: ${command.join(' ')}: ${v.error?.code} ${v.error?.message || ''}`.trim());
    if (v.data?.outcome !== 'passed') { s.nextAction = 'the author fixes the validation failure, then a fresh run'; run.stop('WAITING_FOR_OWNER', `validation failed: ${command.join(' ')}`); }
  }
  const after = checkoutProblem(checkout, target.headOid); if (after) run.stop('BLOCKED', `validation changed the checkout: ${after}`);
  s.ignoredDelta = ignoredInventory(checkout); run.save();
  // Validation takes time; the target and its body are revalidated before the first gate (CONV-199-FIRST-BODY-REVALIDATION).
  revalidate(run);
  collectSnapshotEvidence(run);
  launch(run, 'convergence', { fresh: true });
}

// Before every gate after the first and at final readiness: the target, the pull request body, the checkout, and every
// head fingerprint (the issue spec re-read) must be unchanged (review-only.md "Revalidate the target and its evidence
// before each gate").
function revalidate(run) {
  const s = run.state, t = s.target;
  const pull = gh(['api', `repos/${t.repository}/pulls/${t.number}`], s.checkout);
  const moved = targetMoved(t, pull); if (moved) run.stop('BLOCKED', moved);
  const checkout = checkoutProblem(s.checkout, t.headOid); if (checkout) run.stop('BLOCKED', checkout);
  const ignored = ignoredInventory(s.checkout);
  const drift = [...ignored.filter((x) => !s.ignoredDelta.includes(x)), ...s.ignoredDelta.filter((x) => !ignored.includes(x))];
  if (drift.length) run.stop('BLOCKED', `the checkout's ignored paths changed after validation: ${drift.slice(0, 5).join(', ')}`);
  sameSpec(run, pull, s.checkout);
}

function launch(run, gate, { fresh = false } = {}) {
  const s = run.state, t = s.target;
  if (gate === 'convergence' && s.convergenceDisabled) return launch(run, 'adversarial', { fresh });
  if (!fresh) {
    revalidate(run);
    // New external evidence before a later gate reruns convergence first (DEC-109-CONV-SNAPSHOT-001).
    if (collectSnapshotEvidence(run).fresh && gate !== 'convergence') { s.verdicts = {}; s.invalidated = 'every gate verdict: the external snapshot changed before a later gate'; return launch(run, 'convergence', { fresh: true }); }
  }
  // gate-contract.md: convergence at its cap hands the candidate to Sol; ROUND_LIMIT_REACHED is the formal gates'.
  if ((s.invocations[gate] || 0) >= ROUND_CAP) { if (gate === 'convergence') return launch(run, 'adversarial', { fresh: true }); run.stop('ROUND_LIMIT_REACHED', `${label(gate)} reached its ${ROUND_CAP}-round cap`); }
  s.invocations[gate] = (s.invocations[gate] || 0) + 1;
  const invocation = s.invocations[gate];
  run.op('required_evidence_check', { cwd: s.checkout, requiredEvidence: s.requiredEvidence });
  const correlation = { repository: t.repository, number: t.number, baseOid: t.baseOid, headRepository: t.headRepository, headBranch: t.headBranch, headOid: t.headOid, lifecycle: 'open', draft: false, gate, invocation, contractInput: s.contractInput, snapshotFingerprint: s.fingerprints.snapshot };
  const expectation = run.op('build_gate_expectation', { workflow: 'pr', correlation, assignedFindings: gate === 'adversarial' ? s.assigned || [] : [], requiredEvidence: s.requiredEvidence }).data;
  const expectationPath = run.file(`expectation-${gate}-${invocation}.json`, expectation.expected);
  const settled = s.findings.filter((f) => f.recorded).map((f) => ({ findingId: f.findingId, sourceGate: f.gate, disposition: f.disposition, status: 'settled', summary: f.summary }));
  const volatile = { target: { repository: t.repository, number: t.number, headRepository: t.headRepository, headBranch: t.headBranch, baseOid: t.baseOid, headOid: t.headOid, mode: 'review-only', gate },
    fingerprints: s.fingerprints, body: s.body, diff: fs.readFileSync(path.join(run.dir, 'pr.diff'), 'utf8'), languageProfile: s.languageProfile, acceptanceCriteria: s.acceptanceCriteria, history: { unresolved: gate === 'adversarial' ? s.unresolved || [] : [], reopened: [], settled } };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = trustedComments(run); }
  const built = run.op('build_gate_launch', { expectation, expectationPath, volatile }).data;
  Object.assign(s, { activeGate: gate, state: 'GATE_LAUNCH_PENDING', pending: { gate, invocation, expectationPath, launch: run.file(`launch-${gate}-${invocation}.json`, built.request) }, rounds: rounds(s) });
  run.save();
  run.next(built.request, `${__filename} result`);
}

function result(opts) {
  const run = Run.open(opts), s = run.state, p = s.pending;
  if (!p) die('no gate is pending in this run');
  guard(run);
  s.nextAction = null; s.operatorActions = null;
  const read = readGate(run, opts['run-id'], __filename, { before: () => revalidate(run) });
  if (!read) return;
  const envelope = read.envelope, gate = p.gate, findings = envelope.findings || [];
  const status = read.statusPath ? JSON.parse(fs.readFileSync(read.statusPath, 'utf8')) : {};
  // One entry per role that ran, its latest resolution.
  s.resolved = [...s.resolved.filter((x) => !x.startsWith(`${ROLE[gate]} `)), roleLabel(ROLE[gate], ((status.steps || []).at(-1) || {}).model, ((status.steps || []).at(-1) || {}).thinking)];
  s.verdicts[gate] = envelope.verdict; s.pending = null;
  s.gateLog.push({ gate, invocation: p.invocation, head: s.target.headOid, verdict: envelope.verdict, findings: findings.map((x) => `${x.findingId} (${x.severity})`).join(', ') });
  // An assigned finding the gate confirms is resolved on this unchanged head, unless it still asks for a fix or for the
  // owner; the validated envelope is the confirmation authority (gate-contract.md).
  const confirmed = new Set((envelope.confirmations || []).filter((c) => c.confirmation === 'confirmed').map((c) => c.findingId));
  const settled = (x) => x.origin === 'assigned' && confirmed.has(x.findingId) && !['fixed', 'needs-owner-decision'].includes(x.proposedDisposition);
  const open = findings.filter((x) => !isRecorded(x) && !settled(x));
  for (const x of findings) s.findings = [...s.findings.filter((f) => f.findingId !== x.findingId), { findingId: x.findingId, gate, recorded: isRecorded(x) || settled(x), summary: String(x.correction || '').slice(0, 200),
    disposition: settled(x) ? `${x.proposedDisposition} (confirmed by ${label(gate)})` : isRecorded(x) ? `${x.proposedDisposition} (recorded under CL-D85)` : `${x.proposedDisposition} (proposed; correction pending)` }];
  const decisions = (envelope.decisions || []).filter((d) => d.status === 'pending').map((d) => d.decisionId);
  if (envelope.verdict === 'NEEDS DECISION' || decisions.length) { s.pendingDecisions = decisions; s.nextAction = 'the owner records the decision, then a fresh run'; run.stop('WAITING_FOR_OWNER', `${label(gate)} returned NEEDS DECISION`); }
  // gate-contract.md (CL-D62): convergence at its cap with findings open hands the candidate to Sol with those findings
  // assigned, and convergence is not invoked again; earlier rounds stop for the author as before.
  if (open.length && gate === 'convergence' && p.invocation >= ROUND_CAP) {
    s.assigned = run.op('build_gate_assignments', { findings: open, settledKeys: [] }).data.assignedFindings;
    s.unresolved = open.map((x) => ({ ...x, blockerKey: s.assigned.find((a) => a.findingId === x.findingId).blockerKey }));
    return launch(run, 'adversarial');
  }
  if (open.length) { s.nextAction = 'the author applies the smallest correction, then a fresh run'; s.invalidated = 'all head-bound evidence once a correction is pushed'; run.stop('WAITING_FOR_OWNER', `${label(gate)} returned ${envelope.verdict} with open finding(s): ${open.map((x) => x.findingId).join(', ')}`); }
  const next = GATES[GATES.indexOf(gate) + 1];
  if (next) return launch(run, next);
  return finalReadiness(run);
}

// Final readiness from a fresh snapshot on the same head: new external evidence reruns convergence
// (DEC-109-CONV-SNAPSHOT-001); an unresolved review thread is an external finding for the owner; then the final policy.
function finalReadiness(run) {
  const s = run.state;
  revalidate(run);
  const { snapshot, fresh } = collectSnapshotEvidence(run);
  s.activeGate = 'external'; s.rounds = rounds(s);
  if (fresh) { s.verdicts = {}; s.invalidated = 'every gate verdict: the external snapshot changed at final readiness'; return launch(run, 'convergence', { fresh: true }); }
  finalPolicy(run, snapshot, `wait, then run: node ${__filename} resume --run-dir ${run.dir}`);
  s.invalidated = null;
  run.stop('MERGE_READY', `${s.convergenceDisabled ? 'convergence was disabled; Sol and Terra' : 'convergence, Sol and Terra'} returned MERGE on the unchanged head; the final policy passes`);
}

// review-only.md: a stopped run resumes only after every fingerprint is recomputed, never trusting recorded state; a
// changed target is refused and what moved is reported. Only a WAITING_EXTERNAL_REVIEW stop has work left to resume;
// every other stop is completed by a fresh run. The resumed run reports its own observation time.
function resume(opts) {
  const run = Run.open(opts), s = run.state;
  if (s.state !== 'WAITING_EXTERNAL_REVIEW') die(`a ${s.state} run is not resumable; start a fresh run`);
  guard(run);
  s.reason = null; s.nextAction = null; s.operatorActions = null;
  return finalReadiness(run);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  if (command === 'start') start(opts);
  else if (command === 'result') result(opts);
  else if (command === 'resume') resume(opts);
  else if (command === 'status') process.stdout.write(`${JSON.stringify(Run.open(opts).state, null, 2)}\n`);
  else die('usage: review.js start|result|resume|status');
} catch (error) {
  // A run with a directory ends through its guard, with a token and a status block; before that, a plain failure.
  if (process.listenerCount('uncaughtException')) throw error;
  die(error.stack || String(error));
}

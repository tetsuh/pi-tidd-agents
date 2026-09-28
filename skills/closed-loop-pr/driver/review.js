'use strict';

// CL-D93 (#196): the packaged review-only driver. It sequences one PR review round from the package's helpers in the
// order review-only.md states and leaves the parent one thing per gate: the `subagent` call it prints. Gates judge;
// the driver never does.
//
//   node review.js start  --pr N [--repo owner/name] [--issue N] [--checkout DIR] [--run-dir DIR] [--language-profile P]
//   node review.js result --run-dir DIR --run-id ID
//   node review.js resume --run-dir DIR
//   node review.js status --run-dir DIR

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Run, headFingerprints, snapshotFingerprint, runDirProblem, targetMoved, roleLabel, evidenceIds, readiness, checkoutProblem, ROLE, LANGUAGE_PROFILE, sha256, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands } = require('./run');

const GATES = ['convergence', 'adversarial', 'safety'];
const ROUND_CAP = 3;
const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
// gate-contract.md: a missing or unparsable result is relaunched once without spending a round; still running is
// neither a result nor a failure.
const RELAUNCHABLE = new Set(['designated_output_absent', 'designated_output_empty', 'designated_output_unparsable', 'designated_output_unrecorded', 'schema_invalid', 'unknown_field', 'unknown_enum', 'finding_records_invalid', 'confirmation_records_invalid', 'evidence_records_invalid', 'verdict_inconsistent']);

function label(gate) { return { adversarial: 'sol', safety: 'terra' }[gate] || gate; }
function rounds(s) { return GATES.map((g) => `${label(g)} ${s.invocations[g] || 0}/${ROUND_CAP}`).join(', '); }
function describeExternal(snapshot) {
  const r = readiness(snapshot, snapshot.after.head);
  return `${(snapshot.comments || []).length} comments, ${(snapshot.reviews || []).length} reviews, ${(snapshot.threads || []).length} threads (${r.unresolved.length} unresolved), ${(snapshot.checks || []).length} checks and ${(snapshot.statuses || []).length} statuses (${r.failed.length} failing, ${r.pending.length} pending)`;
}
function readIssue(run) {
  const s = run.state, t = s.target;
  const issue = gh(['api', `repos/${t.repository}/issues/${s.issueNumber}`], s.checkout);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${t.repository}/issues/${s.issueNumber}/comments?per_page=100`], s.checkout).flat();
  return { issue, comments };
}
// Once a run directory exists, a failure anywhere still ends the run with an outcome token and a status block.
function guard(run) { process.on('uncaughtException', (error) => run.stop('BLOCKED', `the driver failed: ${String(error.message).split('\n')[0]}`)); }

function start(opts) {
  const number = Number(opts.pr); if (!Number.isInteger(number) || number <= 0) die('--pr must be a pull request number');
  const checkout = path.resolve(opts.checkout || process.cwd());
  // The location is judged before anything is created: the given directory, or the temporary root a default goes under.
  const problem = runDirProblem(opts['run-dir'] ? path.resolve(opts['run-dir']) : os.tmpdir()); if (problem) die(problem);
  // The target is resolved before anything is created, so a lookup that fails leaves no half-run behind.
  let repository, pull;
  try {
    repository = opts.repo || gh(['repo', 'view', '--json', 'nameWithOwner'], checkout).nameWithOwner;
    pull = gh(['api', `repos/${repository}/pulls/${number}`], checkout);
  } catch (error) { die(`cannot read pull request ${repository || ''}#${number}: ${String(error.message).split('\n')[0]}`); }
  // Every field the target binds is checked here too, so a missing one (a deleted fork's head repository) leaves no run.
  for (const [name, value] of [['base commit', pull.base?.sha], ['base branch', pull.base?.ref], ['head commit', pull.head?.sha], ['head branch', pull.head?.ref], ['head repository', pull.head?.repo?.full_name]]) {
    if (typeof value !== 'string' || !value) die(`cannot bind pull request ${repository}#${number}: its ${name} is missing`);
  }
  const runDir = opts['run-dir'] ? path.resolve(opts['run-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), `tidd-pr${number}-review.`));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = new Run(runDir), s = run.state;
  Object.assign(s, { mode: 'review-only', checkout, startedAt: new Date().toISOString(), invocations: {}, verdicts: {}, findings: [], resolved: [], gateLog: [], languageProfile: opts['language-profile'] || LANGUAGE_PROFILE });
  s.rounds = rounds(s);
  run.file('pr-before.json', pull);
  s.target = { repository, number, baseOid: pull.base.sha, baseBranch: pull.base.ref, headOid: pull.head.sha, headRepository: pull.head.repo.full_name, headBranch: pull.head.ref };
  s.body = pull.body || '';
  s.contractInput = contractInput(CONTRACT_INPUT_FILES);
  run.save();
  guard(run);
  const target = s.target;
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
  const validation = validationCommands(checkout, target.baseOid);
  if (validation.problem) run.stop('BLOCKED', validation.problem);
  const evidence = headFingerprints(run, { cwd: checkout, baseOid: target.baseOid, headOid: target.headOid, issue, comments });
  run.file('pr.diff', evidence.diff);
  s.fingerprints = evidence.values; s.records = evidence.records;
  const results = [];
  for (const command of [...validation.commands, ['git', 'diff', '--check', `${target.baseOid}...${target.headOid}`]]) {
    const v = run.op('validation_run', { cwd: checkout, command, timeoutMs: 1800000 }, { allowFail: true });
    results.push(`${command.join(' ')}: ${v.data?.outcome || v.error?.code}`);
    s.validation = results.join('; ');
    // A failed command is a validation result; a harness that could not run it is never a verdict (review-only.md).
    if (v.ok === false && v.error?.code !== 'validation_failed') run.stop('BLOCKED', `harness_failed: ${command.join(' ')}: ${v.error?.code} ${v.error?.message || ''}`.trim());
    if (v.data?.outcome !== 'passed') { s.nextAction = 'the author fixes the validation failure, then a fresh run'; run.stop('WAITING_FOR_OWNER', `validation failed: ${command.join(' ')}`); }
  }
  const after = checkoutProblem(checkout, target.headOid); if (after) run.stop('BLOCKED', `validation changed the checkout: ${after}`);
  collectSnapshotEvidence(run);
  launch(run, 'convergence', { fresh: true });
}

// The snapshot, its fingerprint, the evidence envelope, and the required-evidence set, as of now.
function collectSnapshotEvidence(run) {
  const s = run.state, t = s.target, [owner, repo] = t.repository.split('/');
  const snapshot = run.op('snapshot', { owner, repo, number: t.number, cwd: s.checkout }).data;
  const moved = targetMoved(t, { base: { sha: snapshot.after.base }, head: { sha: snapshot.after.head, ref: snapshot.after.headBranch, repo: { full_name: snapshot.after.headRepository } }, state: snapshot.after.state, draft: snapshot.after.draft });
  if (moved) run.stop('BLOCKED', moved);
  const snap = snapshotFingerprint(run, snapshot);
  s.fingerprints.snapshot = snap.value; s.records.snapshot = snap.record;
  s.observedFrom = new Date().toISOString(); s.external = describeExternal(snapshot); s.evidenceIds = evidenceIds(snapshot);
  const captureIdentity = { repository: t.repository, number: t.number, baseOid: t.baseOid, baseBranch: t.baseBranch, headOid: t.headOid, headRepository: t.headRepository, headBranch: t.headBranch, state: 'open', draft: false };
  run.op('evidence_verify', { envelope: { schemaVersion: 1, captureIdentity, brackets: { before: snapshot.before, after: snapshot.after }, completeness: snapshot.completeness, fingerprints: s.records }, expected: { ...captureIdentity, fingerprints: s.fingerprints } });
  const fp = s.fingerprints;
  const identities = [...['pr_base', 'pr_head', 'pr_tree', 'pr_diff', 'pr_commits'].map((d) => ({ source: `git:${d}`, kind: 'git', identity: fp[d] })),
    { source: `github:issue:${s.issueNumber}:spec`, kind: 'github', identity: fp.issue_spec },
    { source: `github:pr:${t.number}:body`, kind: 'github', identity: sha256(Buffer.from(s.body.replace(/\r\n?/g, '\n'), 'utf8')) },
    { source: `snapshot:pr:${t.number}`, kind: 'snapshot', identity: fp.snapshot }];
  s.requiredEvidence = run.op('required_evidence_set', { cwd: s.checkout, baseOid: t.baseOid, headOid: t.headOid, identities }).data.requiredEvidence;
  run.save();
  return snapshot;
}

// Before every gate after the first and at final readiness: the target, the pull request body, the checkout, and every
// head fingerprint (the issue spec re-read) must be unchanged (review-only.md "Revalidate the target and its evidence
// before each gate").
function revalidate(run) {
  const s = run.state, t = s.target;
  const pull = gh(['api', `repos/${t.repository}/pulls/${t.number}`], s.checkout);
  const moved = targetMoved(t, pull); if (moved) run.stop('BLOCKED', moved);
  const checkout = checkoutProblem(s.checkout, t.headOid); if (checkout) run.stop('BLOCKED', checkout);
  if ((pull.body || '') !== s.body) run.stop('BLOCKED', 'the target moved: the pull request body changed');
  const { issue, comments } = readIssue(run);
  const now = headFingerprints(run, { cwd: s.checkout, baseOid: t.baseOid, headOid: t.headOid, issue, comments }).values;
  const changed = Object.keys(now).filter((k) => now[k] !== s.fingerprints[k]);
  if (changed.length) run.stop('BLOCKED', `the target moved: ${changed.join(', ')} changed`);
}

function launch(run, gate, { fresh = false } = {}) {
  const s = run.state, t = s.target;
  if (!fresh) {
    revalidate(run);
    const known = s.evidenceIds || [];
    collectSnapshotEvidence(run);
    // New external evidence before a later gate reruns convergence first (DEC-109-CONV-SNAPSHOT-001).
    if (gate !== 'convergence' && s.evidenceIds.some((id) => !known.includes(id))) { s.verdicts = {}; s.invalidated = 'every gate verdict: new external evidence arrived before a later gate'; return launch(run, 'convergence', { fresh: true }); }
  }
  // gate-contract.md: convergence at its cap hands the candidate to Sol; ROUND_LIMIT_REACHED is the formal gates'.
  if ((s.invocations[gate] || 0) >= ROUND_CAP) { if (gate === 'convergence') return launch(run, 'adversarial', { fresh: true }); run.stop('ROUND_LIMIT_REACHED', `${label(gate)} reached its ${ROUND_CAP}-round cap`); }
  s.invocations[gate] = (s.invocations[gate] || 0) + 1;
  const invocation = s.invocations[gate];
  run.op('required_evidence_check', { cwd: s.checkout, requiredEvidence: s.requiredEvidence });
  const correlation = { repository: t.repository, number: t.number, baseOid: t.baseOid, headRepository: t.headRepository, headBranch: t.headBranch, headOid: t.headOid, lifecycle: 'open', draft: false, gate, invocation, contractInput: s.contractInput, snapshotFingerprint: s.fingerprints.snapshot };
  const expectation = run.op('build_gate_expectation', { workflow: 'pr', correlation, assignedFindings: [], requiredEvidence: s.requiredEvidence }).data;
  const expectationPath = run.file(`expectation-${gate}-${invocation}.json`, expectation.expected);
  const settled = s.findings.filter((f) => f.recorded).map((f) => ({ findingId: f.findingId, sourceGate: f.gate, disposition: f.disposition, status: 'settled', summary: f.summary }));
  const volatile = { target: { repository: t.repository, number: t.number, headRepository: t.headRepository, headBranch: t.headBranch, baseOid: t.baseOid, headOid: t.headOid, mode: 'review-only', gate },
    fingerprints: s.fingerprints, body: s.body, diff: fs.readFileSync(path.join(run.dir, 'pr.diff'), 'utf8'), languageProfile: s.languageProfile, acceptanceCriteria: s.acceptanceCriteria, history: { unresolved: [], reopened: [], settled } };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = JSON.parse(fs.readFileSync(path.join(run.dir, 'issue-comments.json'), 'utf8')).filter((c) => TRUSTED.includes(c.author_association)); }
  const built = run.op('build_gate_launch', { expectation, expectationPath, volatile }).data;
  Object.assign(s, { activeGate: gate, state: 'GATE_LAUNCH_PENDING', pending: { gate, invocation, expectationPath, launch: run.file(`launch-${gate}-${invocation}.json`, built.request) }, rounds: rounds(s) });
  run.save();
  run.next(built.request, `${__filename} result`);
}

function result(opts) {
  const run = Run.open(opts), s = run.state, p = s.pending;
  if (!p) die('no gate is pending in this run');
  guard(run);
  const read = run.op('gate_result_read', { runId: opts['run-id'] || die('--run-id is required'), expectationPath: p.expectationPath }, { allowFail: true });
  if (!read.ok) {
    const code = read.error?.code;
    if (code === 'run_in_progress') { process.stdout.write(`WAIT: the ${label(p.gate)} run is still in progress; when it completes, run: node ${__filename} result --run-dir ${run.dir} --run-id <runId>\n`); process.exit(3); }
    if (RELAUNCHABLE.has(code) && !p.relaunched) {
      p.relaunched = true; run.save();
      run.next(JSON.parse(fs.readFileSync(p.launch, 'utf8')), `${__filename} result`);
      return;
    }
    run.stop('BLOCKED', `gate_result_read refused${p.relaunched ? ' after one relaunch' : ''}: ${code} ${read.error?.message || ''}`.trim());
  }
  const envelope = read.data.envelope, gate = p.gate, findings = envelope.findings || [];
  const status = read.data.statusPath ? JSON.parse(fs.readFileSync(read.data.statusPath, 'utf8')) : {};
  s.resolved.push(roleLabel(ROLE[gate], ((status.steps || []).at(-1) || {}).model));
  s.verdicts[gate] = envelope.verdict; s.pending = null;
  s.gateLog.push({ gate, invocation: p.invocation, head: s.target.headOid, verdict: envelope.verdict, findings: findings.map((x) => `${x.findingId} (${x.severity})`).join(', ') });
  // CL-D85: a Minor whose correction changes no file of the head is recorded and advances; any other finding is open.
  // Whether a correction changes no file is not readable from a proposed disposition, so only the classes that change
  // none by construction are recorded (CONV-199-CLD85-MINOR-BYPASS).
  const isRecorded = (x) => x.severity === 'Minor' && (x.anchoring === 'reword' || x.anchoring === 'follow-up' || x.outOfScope === true);
  const open = findings.filter((x) => !isRecorded(x));
  for (const x of findings) s.findings.push({ findingId: x.findingId, gate, recorded: isRecorded(x), summary: String(x.correction || '').slice(0, 200),
    disposition: isRecorded(x) ? `${x.proposedDisposition} (recorded under CL-D85)` : `${x.proposedDisposition} (proposed; correction pending)` });
  const decisions = (envelope.decisions || []).filter((d) => d.status === 'pending').map((d) => d.decisionId);
  if (envelope.verdict === 'NEEDS DECISION' || decisions.length) { s.pendingDecisions = decisions; s.nextAction = 'the owner records the decision, then a fresh run'; run.stop('WAITING_FOR_OWNER', `${label(gate)} returned NEEDS DECISION`); }
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
  const known = s.evidenceIds || [];
  const snapshot = collectSnapshotEvidence(run);
  s.activeGate = 'external'; s.rounds = rounds(s);
  if (s.evidenceIds.some((id) => !known.includes(id))) { s.verdicts = {}; s.invalidated = 'every gate verdict: new external evidence arrived at final readiness'; return launch(run, 'convergence', { fresh: true }); }
  const r = readiness(snapshot, s.target.headOid);
  if (r.unresolved.length) { s.nextAction = 'the owner dispositions the external findings, then a fresh run'; s.operatorActions = `disposition and resolve ${r.unresolved.length} external review thread(s)`; run.stop('WAITING_FOR_OWNER', `unresolved external finding(s): ${r.unresolved.join('; ')}`); }
  if (r.failed.length) { s.nextAction = 'the author addresses the failure, then a fresh run'; run.stop('BLOCKED', `final policy failed: ${r.failed.join('; ')}`); }
  if (r.pending.length) { s.nextAction = `wait, then run: node ${__filename} resume --run-dir ${run.dir}`; run.stop('WAITING_EXTERNAL_REVIEW', `pending: ${r.pending.join('; ')}`); }
  s.activeGate = 'none'; s.nextAction = 'human merge decision; the workflow never merges'; s.operatorActions = 'none; a human may merge';
  run.stop('MERGE_READY', 'convergence, Sol and Terra returned MERGE on the unchanged head; the final policy passes');
}

// review-only.md: a stopped run resumes only after every fingerprint is recomputed, never trusting recorded state; a
// changed target is refused and what moved is reported. Only a WAITING_EXTERNAL_REVIEW stop has work left to resume;
// every other stop is completed by a fresh run. The resumed run reports its own observation time.
function resume(opts) {
  const run = Run.open(opts), s = run.state;
  if (s.state !== 'WAITING_EXTERNAL_REVIEW') die(`a ${s.state} run is not resumable; start a fresh run`);
  guard(run);
  s.reason = null;
  return finalReadiness(run);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  if (command === 'start') start(opts);
  else if (command === 'result') result(opts);
  else if (command === 'resume') resume(opts);
  else if (command === 'status') process.stdout.write(fs.readFileSync(path.join(path.resolve(opts['run-dir'] || die('--run-dir is required')), 'state.json'), 'utf8'));
  else die('usage: review.js start|result|resume|status');
} catch (error) {
  // A run with a directory ends through its guard, with a token and a status block; before that, a plain failure.
  if (process.listenerCount('uncaughtException')) throw error;
  die(error.stack || String(error));
}

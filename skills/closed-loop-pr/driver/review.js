'use strict';

// CL-D93 (#196): the packaged review-only driver. It sequences one PR review round from the package's helpers in the
// order the contract states and leaves the parent one thing per gate: the `subagent` call it prints. Gates judge; the
// driver never does.
//
//   node review.js start  --pr N [--repo owner/name] [--issue N] [--checkout DIR] [--run-dir DIR]
//   node review.js result --run-dir DIR --run-id ID
//   node review.js resume --run-dir DIR
//   node review.js status --run-dir DIR

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Run, headFingerprints, snapshotFingerprint, runDirProblem, targetMoved, roleLabel, evidenceIds, approvalShortfall, ROLE, LANGUAGE_PROFILE, sha256, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands } = require('./run');

const GATES = ['convergence', 'adversarial', 'safety'];
const ROUND_CAP = 3;
const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function start(opts) {
  const number = Number(opts.pr); if (!Number.isInteger(number) || number <= 0) die('--pr must be a pull request number');
  const checkout = path.resolve(opts.checkout || process.cwd());
  // The location is judged before anything is created: the given directory, or the temporary root a default goes under.
  const problem = runDirProblem(opts['run-dir'] ? path.resolve(opts['run-dir']) : os.tmpdir()); if (problem) die(problem);
  const runDir = opts['run-dir'] ? path.resolve(opts['run-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), `tidd-pr${number}-review.`));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = new Run(runDir), s = run.state;
  const repository = opts.repo || gh(['repo', 'view', '--json', 'nameWithOwner'], checkout).nameWithOwner;
  const [owner, repo] = repository.split('/');
  const pull = gh(['api', `repos/${repository}/pulls/${number}`], checkout);
  run.file('pr-before.json', pull);
  const target = { repository, number, baseOid: pull.base.sha, baseBranch: pull.base.ref, headOid: pull.head.sha, headRepository: pull.head.repo.full_name, headBranch: pull.head.ref };
  Object.assign(s, { mode: 'review-only', target, checkout, startedAt: new Date().toISOString(), body: pull.body || '', invocations: {}, verdicts: {}, findings: [], resolved: [], gateLog: [] });
  s.contractInput = contractInput(CONTRACT_INPUT_FILES);
  run.save();
  if (pull.state !== 'open' || pull.draft) run.stop('BLOCKED', `the pull request is ${pull.state}${pull.draft ? ' (draft)' : ''}`);
  const head = git(checkout, ['rev-parse', 'HEAD']).trim();
  if (head !== target.headOid) run.stop('BLOCKED', `the checkout is at ${head}, not the public head ${target.headOid}`);
  // The Issue this PR serves, its acceptance criteria, and the validation the base commit names; each gap stops here.
  const closes = opts.issue ? [null, String(opts.issue)] : /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(s.body);
  if (!closes) run.stop('BLOCKED', 'the PR body names no `Closes #N` issue and no --issue was given');
  s.issueNumber = Number(closes[1]);
  const issue = gh(['api', `repos/${repository}/issues/${s.issueNumber}`], checkout);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues/${s.issueNumber}/comments?per_page=100`], checkout).flat();
  run.file('issue.json', issue); run.file('issue-comments.json', comments);
  s.acceptanceCriteria = acceptanceCriteria(issue.body);
  if (!s.acceptanceCriteria.length) run.stop('BLOCKED', `issue #${s.issueNumber} has no Acceptance criteria section with at least one criterion`);
  const validation = validationCommands(checkout, target.baseOid);
  if (validation.problem) run.stop('BLOCKED', validation.problem);
  // Evidence of the head (CL-D9), bracketed by the pull request read before it.
  const evidence = headFingerprints(run, { cwd: checkout, baseOid: target.baseOid, headOid: target.headOid, issue, comments });
  run.file('pr.diff', evidence.diff);
  const fp = evidence.values, records = evidence.records;
  const results = [];
  for (const command of [...validation.commands, ['git', 'diff', '--check', `${target.baseOid}...${target.headOid}`]]) {
    const v = run.op('validation_run', { cwd: checkout, command, timeoutMs: 1800000 }, { allowFail: true });
    results.push(`${command.join(' ')}: ${v.data?.outcome || v.error?.code}`);
    if (v.data?.outcome !== 'passed') { s.validation = results.join('; '); s.nextAction = 'the author fixes the validation failure, then a fresh run'; run.stop('WAITING_FOR_OWNER', `validation failed: ${command.join(' ')}`); }
  }
  s.validation = results.join('; ');
  const snapshot = run.op('snapshot', { owner, repo, number, cwd: checkout }).data;
  if (snapshot.after.head !== target.headOid || snapshot.after.base !== target.baseOid) run.stop('BLOCKED', 'the target moved during evidence collection');
  const snap = snapshotFingerprint(run, snapshot);
  fp.snapshot = snap.value; records.snapshot = snap.record;
  s.fingerprints = fp; s.observedFrom = new Date().toISOString();
  s.external = describeExternal(snapshot); s.evidenceIds = evidenceIds(snapshot);
  const envelope = { schemaVersion: 1, captureIdentity: { repository, number, baseOid: target.baseOid, baseBranch: target.baseBranch, headOid: target.headOid, headRepository: target.headRepository, headBranch: target.headBranch, state: 'open', draft: false },
    brackets: { before: snapshot.before, after: snapshot.after }, completeness: snapshot.completeness,
    fingerprints: records };
  run.op('evidence_verify', { envelope, expected: { ...envelope.captureIdentity, fingerprints: fp } });
  const identities = [...['pr_base', 'pr_head', 'pr_tree', 'pr_diff', 'pr_commits'].map((d) => ({ source: `git:${d}`, kind: 'git', identity: fp[d] })),
    { source: `github:issue:${s.issueNumber}:spec`, kind: 'github', identity: fp.issue_spec },
    { source: `github:pr:${number}:body`, kind: 'github', identity: sha256(Buffer.from(s.body.replace(/\r\n?/g, '\n'), 'utf8')) },
    { source: `snapshot:pr:${number}`, kind: 'snapshot', identity: fp.snapshot }];
  s.identities = identities;
  s.requiredEvidence = run.op('required_evidence_set', { cwd: checkout, baseOid: target.baseOid, headOid: target.headOid, identities }).data.requiredEvidence;
  run.save();
  launch(run, 'convergence');
}

function describeExternal(snapshot) {
  const checks = snapshot.policies?.checks || [], external = snapshot.policies?.externalReview || [];
  return `${(snapshot.comments || []).length} comments, ${(snapshot.reviews || []).length} reviews, ${(snapshot.threads || []).length} threads, ${checks.length} checks (${checks.filter((c) => c.failed).length} failing, ${checks.filter((c) => c.pending).length} pending)${external.length ? `, ${external.map((r) => `${r.provider} ${r.state}`).join(', ')}` : ''}`;
}

function rounds(s) { return GATES.map((g) => `${{ adversarial: 'sol', safety: 'terra' }[g] || g} ${s.invocations[g] || 0}/${ROUND_CAP}`).join(', '); }

function launch(run, gate) {
  const s = run.state, t = s.target;
  // The first gate launches right after evidence collection; every later one re-resolves the target first.
  if (gate !== 'convergence') { const moved = targetMoved(t, gh(['api', `repos/${t.repository}/pulls/${t.number}`], s.checkout)); if (moved) run.stop('BLOCKED', moved); }
  s.invocations[gate] = (s.invocations[gate] || 0) + 1;
  const invocation = s.invocations[gate];
  if (invocation > ROUND_CAP) run.stop('ROUND_LIMIT_REACHED', `${gate} reached its ${ROUND_CAP}-round cap`);
  run.op('required_evidence_check', { cwd: s.checkout, requiredEvidence: s.requiredEvidence });
  const correlation = { repository: t.repository, number: t.number, baseOid: t.baseOid, headRepository: t.headRepository, headBranch: t.headBranch, headOid: t.headOid, lifecycle: 'open', draft: false, gate, invocation, contractInput: s.contractInput, snapshotFingerprint: s.fingerprints.snapshot };
  const expectation = run.op('build_gate_expectation', { workflow: 'pr', correlation, assignedFindings: [], requiredEvidence: s.requiredEvidence }).data;
  const expectationPath = run.file(`expectation-${gate}-${invocation}.json`, expectation.expected);
  const volatile = { target: { repository: t.repository, number: t.number, headRepository: t.headRepository, headBranch: t.headBranch, baseOid: t.baseOid, headOid: t.headOid, mode: 'review-only', gate },
    fingerprints: s.fingerprints, body: s.body, diff: fs.readFileSync(path.join(run.dir, 'pr.diff'), 'utf8'), languageProfile: LANGUAGE_PROFILE, acceptanceCriteria: s.acceptanceCriteria, history: { unresolved: [], reopened: [], settled: [] } };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = JSON.parse(fs.readFileSync(path.join(run.dir, 'issue-comments.json'), 'utf8')).filter((c) => TRUSTED.includes(c.author_association)); }
  const built = run.op('build_gate_launch', { expectation, expectationPath, volatile }).data;
  Object.assign(s, { activeGate: gate, state: 'GATE_LAUNCH_PENDING', pending: { gate, invocation, expectationPath }, rounds: rounds(s) });
  run.save();
  run.file(`launch-${gate}-${invocation}.json`, built.request);
  run.next(built.request, `${__filename} result`);
}

function result(opts) {
  const run = Run.open(opts), s = run.state, p = s.pending;
  if (!p) die('no gate is pending in this run');
  const read = run.op('gate_result_read', { runId: opts['run-id'] || die('--run-id is required'), expectationPath: p.expectationPath }).data;
  const envelope = read.envelope, gate = p.gate, findings = envelope.findings || [];
  const status = read.statusPath ? JSON.parse(fs.readFileSync(read.statusPath, 'utf8')) : {};
  s.resolved.push(roleLabel(ROLE[gate], ((status.steps || []).at(-1) || {}).model));
  s.verdicts[gate] = envelope.verdict; s.pending = null;
  s.gateLog.push({ gate, invocation: p.invocation, head: s.target.headOid, verdict: envelope.verdict, findings: findings.map((x) => `${x.findingId} (${x.severity})`).join(', ') });
  // CL-D85: a Minor whose correction alters no obligation is recorded and advances; any other finding is open.
  const recorded = findings.filter((x) => x.severity === 'Minor' && (x.anchoring === 'reword' || x.anchoring === 'follow-up' || x.outOfScope === true));
  const open = findings.filter((x) => !recorded.includes(x));
  for (const x of findings) s.findings.push({ findingId: x.findingId, disposition: recorded.includes(x) ? `${x.proposedDisposition} (recorded under CL-D85)` : x.proposedDisposition });
  const decisions = (envelope.decisions || []).filter((d) => d.status === 'pending').map((d) => d.decisionId);
  if (envelope.verdict === 'NEEDS DECISION' || decisions.length) { s.pendingDecisions = decisions; s.nextAction = 'the owner records the decision, then a fresh run'; run.stop('WAITING_FOR_OWNER', `${gate} returned NEEDS DECISION`); }
  if (open.length) { s.nextAction = 'the author applies the smallest correction, then a fresh run'; s.invalidated = 'all head-bound evidence once a correction is pushed'; run.stop('WAITING_FOR_OWNER', `${gate} returned ${envelope.verdict} with open finding(s): ${open.map((x) => x.findingId).join(', ')}`); }
  const next = GATES[GATES.indexOf(gate) + 1];
  if (next) return launch(run, next);
  return finalReadiness(run);
}

// Final readiness from a fresh snapshot on the same head: identity, new external evidence (which reruns convergence
// within its cap, DEC-109-CONV-SNAPSHOT-001), failures, required approvals, pending checks and external review.
function finalReadiness(run) {
  const s = run.state, [owner, repo] = s.target.repository.split('/');
  const snapshot = run.op('snapshot', { owner, repo, number: s.target.number, cwd: s.checkout }).data;
  const moved = targetMoved(s.target, { base: { sha: snapshot.after.base }, head: { sha: snapshot.after.head, ref: snapshot.after.headBranch, repo: { full_name: snapshot.after.headRepository } }, state: snapshot.after.state, draft: snapshot.after.draft });
  if (moved) run.stop('BLOCKED', moved);
  s.external = describeExternal(snapshot); s.activeGate = 'none'; s.rounds = rounds(s);
  const ids = evidenceIds(snapshot);
  if (ids.some((id) => !(s.evidenceIds || []).includes(id))) {
    const snap = snapshotFingerprint(run, snapshot);
    s.fingerprints.snapshot = snap.value; s.evidenceIds = ids; s.observedFrom = new Date().toISOString();
    s.identities = s.identities.map((x) => (x.kind === 'snapshot' ? { ...x, identity: snap.value } : x));
    s.requiredEvidence = run.op('required_evidence_set', { cwd: s.checkout, baseOid: s.target.baseOid, headOid: s.target.headOid, identities: s.identities }).data.requiredEvidence;
    s.verdicts = {}; s.invalidated = 'every gate verdict: new external evidence arrived at final readiness';
    return launch(run, 'convergence');
  }
  const checks = snapshot.policies?.checks || [], external = snapshot.policies?.externalReview || [];
  if (checks.some((c) => c.failed) || external.some((r) => r.state === 'failed') || (snapshot.reviews || []).some((r) => r.state === 'CHANGES_REQUESTED')) { s.nextAction = 'the author addresses failing checks or requested changes, then a fresh run'; run.stop('BLOCKED', 'final policy failed: a failing check, a failed external review, or requested changes'); }
  const shortfall = approvalShortfall(snapshot, s.target.headOid);
  if (shortfall || checks.some((c) => c.pending) || external.some((r) => r.state !== 'completed')) { s.nextAction = 'wait for approvals, checks, and external review on this head, then resume'; run.stop('WAITING_EXTERNAL_REVIEW', shortfall ? `${shortfall} on the head` : 'required checks or external review are pending or unknown'); }
  s.nextAction = 'human merge decision; the workflow never merges'; s.operatorActions = 'none; a human may merge';
  run.stop('MERGE_READY', 'convergence, Sol and Terra returned MERGE on the unchanged head; checks are green');
}

// review-only.md: a stopped run resumes only after every fingerprint is recomputed, never trusting recorded state; a
// changed target is refused and what moved is reported. Only a WAITING_EXTERNAL_REVIEW stop has work left to resume;
// every other stop is completed by a fresh run.
function resume(opts) {
  const run = Run.open(opts), s = run.state, t = s.target;
  if (s.state !== 'WAITING_EXTERNAL_REVIEW') die(`a ${s.state} run is not resumable; start a fresh run`);
  const moved = targetMoved(t, gh(['api', `repos/${t.repository}/pulls/${t.number}`], s.checkout));
  if (moved) run.stop('BLOCKED', moved);
  const issue = gh(['api', `repos/${t.repository}/issues/${s.issueNumber}`], s.checkout);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${t.repository}/issues/${s.issueNumber}/comments?per_page=100`], s.checkout).flat();
  const now = headFingerprints(run, { cwd: s.checkout, baseOid: t.baseOid, headOid: t.headOid, issue, comments }).values;
  const changed = Object.keys(now).filter((k) => now[k] !== s.fingerprints[k]);
  if (changed.length) run.stop('BLOCKED', `the target moved since the stop: ${changed.join(', ')} changed`);
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
} catch (error) { die(error.stack || String(error)); }

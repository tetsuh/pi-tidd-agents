'use strict';

// CL-D93 (#196): the phases of a review-only round, moved out of review.js with the parameters a later driver needs
// (review.js passes the defaults, so its behaviour is unchanged). A later driver can then hold
// every obligation review.js does through the same code: the target bound before any run directory, the guard, the
// Issue read, Sol's trusted comments, the recorded class, the gate-result read, the snapshot evidence, the spec
// revalidation, and the final policy.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { externalEvents, headFingerprints, snapshotFingerprint, runDirProblem, runDirNotFresh, targetMoved, readiness, ignoredInventory, sha256, die, git, gh } = require('./run');

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
// Both driver commands, review.js and autofix.js, load this file before they write. A pipe's writes are asynchronous in
// Node and process.exit drops what the pipe has not yet taken (#237), so both streams block: a write returns once the
// pipe has every byte. A file is written synchronously and has no such handle; a terminal already blocks on POSIX.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
// gate-contract.md: a missing or unparsable result, its runner status record included, is relaunched once without spending a round; still running is
// neither a result nor a failure.
const RELAUNCHABLE = new Set(['status_absent', 'status_unparsable', 'designated_output_absent', 'designated_output_empty', 'designated_output_unparsable', 'designated_output_unrecorded', 'schema_invalid', 'unknown_field', 'unknown_enum', 'finding_records_invalid', 'confirmation_records_invalid', 'evidence_records_invalid', 'verdict_inconsistent', 'result_names_no_run']);
// CL-D104: the driver's own last line sends a pull request back to the prose path; a quoted value is one line, never this
// one, and a control character or line separator in the message (a checkout path may hold one) is folded to a space.
function sendBack(message) { process.stdout.write(`PROSE_PATH: ${String(message).split(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/).join(' ')}\n`); process.exit(2); }
function gateLabel(gate) { return { adversarial: 'sol', safety: 'terra' }[gate] || gate; }

// Everything that can refuse is judged before the run directory exists, so a refusal leaves no half-run behind.
function bindTarget(opts, kind) {
  const number = Number(opts.pr); if (!Number.isInteger(number) || number <= 0) die('--pr must be a pull request number');
  const checkout = path.resolve(opts.checkout || process.cwd());
  // The location is judged first: the given directory, or the temporary root a default goes under.
  const problem = runDirProblem(opts['run-dir'] ? path.resolve(opts['run-dir']) : os.tmpdir()) || (opts['run-dir'] && runDirNotFresh(path.resolve(opts['run-dir']))); if (problem) die(problem);
  let repository, pull;
  try {
    repository = opts.repo || gh(['repo', 'view', '--json', 'nameWithOwner'], checkout).nameWithOwner;
    pull = gh(['api', `repos/${repository}/pulls/${number}`], checkout);
  } catch (error) { die(`cannot read pull request ${repository || ''}#${number}: ${String(error.message).split('\n')[0]}`); }
  // Every field the target binds, so a missing one (a deleted fork's head repository) leaves no run.
  for (const [name, value] of [['base commit', pull.base?.sha], ['base branch', pull.base?.ref], ['head commit', pull.head?.sha], ['head branch', pull.head?.ref], ['head repository', pull.head?.repo?.full_name]]) {
    if (typeof value !== 'string' || !value) die(`cannot bind pull request ${repository}#${number}: its ${name} is missing`);
  }
  // A head from another repository is a foreign pull request, whatever objects happen to be local (CONV-199-FOREIGN-HEAD-LOCAL).
  if (pull.head.repo.full_name.toLowerCase() !== pull.base.repo?.full_name?.toLowerCase()) sendBack(`pull request ${repository}#${number} has its head in another repository (${pull.head.repo.full_name}); review it on the prose path of review-only.md`);
  // The driver reads the head and base from a local checkout. A foreign pull request, or one whose objects are not
  // local, is sent back to the prose path (ADV-199-NO-CHECKOUT-PR, CL-D104).
  for (const oid of [pull.base.sha, pull.head.sha]) {
    try { git(checkout, ['cat-file', '-e', `${oid}^{commit}`]); } catch { sendBack(`the checkout ${checkout} does not hold ${oid}; the driver needs the head and base locally, so review it on the prose path of review-only.md`); }
  }
  const runDir = opts['run-dir'] ? path.resolve(opts['run-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), `tidd-pr${number}-${kind}.`));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // The bound repository is GitHub's canonical name, whatever --repo spelled.
  repository = pull.base.repo.full_name;
  const target = { repository, number, baseOid: pull.base.sha, baseBranch: pull.base.ref, headOid: pull.head.sha, headRepository: pull.head.repo.full_name, headBranch: pull.head.ref };
  return { checkout, runDir, pull, target };
}
// Once a run directory exists, a failure anywhere still ends the run with an outcome token and a status block.
// Git's error output is captured, not passed through (CL-D104), so a failure carries Git's reason: its last fatal or
// error line, else its last line, bounded.
function failure(error) {
  const lines = String(error.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const why = ([...lines].reverse().find((l) => /^(?:fatal|error):/.test(l)) || lines.pop() || '').slice(0, 300);
  return `the driver failed: ${String(error.message).split('\n')[0]}${why ? ` (${why})` : ''}`;
}
function guard(run) { process.on('uncaughtException', (error) => run.stop('BLOCKED', failure(error))); }
function readIssue(run) {
  const s = run.state, t = s.target;
  const issue = gh(['api', `repos/${t.repository}/issues/${s.issueNumber}`], s.checkout);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${t.repository}/issues/${s.issueNumber}/comments?per_page=100`], s.checkout).flat();
  return { issue, comments };
}
// Sol's authoritative comments: a trusted association and never a bot (CONV-199-BOT-COMMENTS-TRUSTED).
function trustedComments(run) { return JSON.parse(fs.readFileSync(path.join(run.dir, 'issue-comments.json'), 'utf8')).filter((c) => TRUSTED.includes(c.author_association) && c.user?.type !== 'Bot'); }
// CL-D85: a Minor whose correction changes no file of the head is recorded and advances. Whether a correction changes
// no file is not readable from a proposed disposition, so only the classes that change none by construction are
// recorded (CONV-199-CLD85-MINOR-BYPASS). A deferred follow-up that is not a Blocker is resolved by the validator's own
// rule, so it advances at any severity (CONV-199-MAJOR-FOLLOWUP-ADVANCES).
function isRecorded(x) {
  return (x.severity === 'Minor' && (x.anchoring === 'reword' || x.anchoring === 'follow-up' || x.outOfScope === true))
    || (x.anchoring === 'follow-up' && x.proposedDisposition === 'deferred' && x.severity !== 'Blocker');
}
// The pending gate's result: a running gate prints WAIT and changes nothing; an unreadable one is relaunched once.
// Returns the read data, or undefined after a relaunch. Exact autofix narrows the relaunch to CL-D51's key: its own
// codes, a budget of its own, and a recheck before the launch is printed again (autofix.md).
function readGate(run, runId, self, { codes = RELAUNCHABLE, may = (p) => !p.relaunched, before = () => {} } = {}) {
  const p = run.state.pending;
  const read = run.op('gate_result_read', { runId: runId || die('--run-id is required'), expectationPath: p.expectationPath }, { allowFail: true });
  if (read.ok) return read.data;
  // A failed step with no designated output is an absent output, not a status verdict (gate-contract.md, CL-D51; #241),
  // unless the runner ended it for its time bound (CL-D94) or its status cannot be read.
  const code = read.error?.code, d = read.error?.details;
  const timedOut = () => { try { return JSON.parse(fs.readFileSync(d.statusPath, 'utf8')).steps.some((x) => x.structuredOutputPath === d.structuredOutputPath && x.timedOut); } catch { return true; } };
  // A correlation whose base and head OIDs and both digests are all the null value names no run: no result of this
  // launch (CL-D107; #254), relaunched as an absent output is: exact autofix within CL-D51's budget.
  const noRun = () => { try { const c = JSON.parse(fs.readFileSync(d.structuredOutputPath, 'utf8')).correlation; return [c.baseOid, c.headOid].every((x) => x === '0'.repeat(40)) && [c.contractInput, c.snapshotFingerprint].every((x) => x === '0'.repeat(64)); } catch { return false; } };
  const as = code === 'step_incomplete' && d?.stepStatus === 'failed' && !fs.existsSync(d.structuredOutputPath || '') && !timedOut() ? 'designated_output_absent'
    : code === 'correlation_mismatch' && noRun() ? 'result_names_no_run' : code;
  if (code === 'run_in_progress') { process.stdout.write(`WAIT: the ${gateLabel(p.gate)} run is still in progress; when it completes, run: node ${self} result --run-dir ${run.dir} --run-id <runId>\n`); process.exit(3); }
  if (codes.has(as) && may(p)) {
    p.relaunched = true; run.save(); before();
    run.next(JSON.parse(fs.readFileSync(p.launch, 'utf8')), `${self} result`);
    return undefined;
  }
  run.stop('BLOCKED', `gate_result_read refused${p.relaunched ? ' after one relaunch' : ''}: ${code} ${read.error?.message || ''}`.trim());
}
function describeExternal(snapshot) {
  const r = readiness(snapshot, snapshot.after.head);
  return `${(snapshot.comments || []).length} comments, ${(snapshot.reviews || []).length} reviews, ${(snapshot.threads || []).length} threads (${r.unresolved.length} unresolved), ${(snapshot.checks || []).length} checks and ${(snapshot.statuses || []).length} statuses (${r.failed.length} failing, ${r.pending.length} pending); external review: ${r.observed.join(', ') || 'none observed'}`;
}
// The snapshot, its fingerprint, the evidence envelope, and the required-evidence set, as of now; `cwd` holds the head.
// Returns the snapshot and whether it carries external evidence the previous one did not.
function collectSnapshotEvidence(run, cwd = run.state.checkout) {
  const s = run.state, t = s.target, [owner, repo] = t.repository.split('/');
  const snapshot = run.op('snapshot', { owner, repo, number: t.number, cwd: s.checkout }).data;
  const moved = targetMoved(t, { base: { sha: snapshot.after.base, ref: snapshot.after.baseBranch }, head: { sha: snapshot.after.head, ref: snapshot.after.headBranch, repo: { full_name: snapshot.after.headRepository } }, state: snapshot.after.state, draft: snapshot.after.draft });
  if (moved) run.stop('BLOCKED', moved);
  const snap = snapshotFingerprint(run, snapshot);
  // Any change of the snapshot, not only a new record, invalidates the gate sequence (ADV-199-SNAPSHOT-INVALIDATION).
  const previous = s.fingerprints.snapshot;
  s.fingerprints.snapshot = snap.value; s.records.snapshot = snap.record; s.snapshotChanged = Boolean(previous) && previous !== snap.value;
  const fresh = s.snapshotChanged;
  s.observedFrom = new Date().toISOString();
  s.external = `${describeExternal(snapshot)}; ${externalEvents(snapshot)}`;
  const captureIdentity = { repository: t.repository, number: t.number, baseOid: t.baseOid, baseBranch: t.baseBranch, headOid: t.headOid, headRepository: t.headRepository, headBranch: t.headBranch, state: 'open', draft: false };
  run.op('evidence_verify', { envelope: { schemaVersion: 1, captureIdentity, brackets: { before: snapshot.before, after: snapshot.after }, completeness: snapshot.completeness, fingerprints: s.records }, expected: { ...captureIdentity, fingerprints: s.fingerprints } });
  const fp = s.fingerprints;
  const identities = [...['pr_base', 'pr_head', 'pr_tree', 'pr_diff', 'pr_commits'].map((d) => ({ source: `git:${d}`, kind: 'git', identity: fp[d] })),
    { source: `github:issue:${s.issueNumber}:spec`, kind: 'github', identity: fp.issue_spec },
    { source: `github:pr:${t.number}:body`, kind: 'github', identity: sha256(Buffer.from(s.body.replace(/\r\n?/g, '\n'), 'utf8')) },
    { source: `snapshot:pr:${t.number}`, kind: 'snapshot', identity: fp.snapshot }];
  s.requiredEvidence = run.op('required_evidence_set', { cwd, baseOid: t.baseOid, headOid: t.headOid, identities }).data.requiredEvidence;
  run.save();
  return { snapshot, fresh };
}
// The pull request body and the fingerprints `keys` names, re-read now, must be what the run bound
// (review-only.md "Revalidate the target and its evidence before each gate"); `cwd` holds the head.
function sameSpec(run, pull, cwd, keys) {
  const s = run.state, t = s.target;
  if ((pull.body || '') !== s.body) run.stop('BLOCKED', 'the target moved: the pull request body changed');
  const { issue, comments } = readIssue(run);
  const now = headFingerprints(run, { cwd, baseOid: t.baseOid, headOid: t.headOid, issue, comments });
  const changed = (keys || Object.keys(now.values)).filter((k) => now.values[k] !== s.fingerprints[k]);
  if (changed.length) run.stop('BLOCKED', `the target moved: ${changed.join(', ')} changed`);
  return now;
}
// The final policy on a fresh snapshot: an unresolved review thread is an external finding for the owner, then failing
// and pending requirements. Returns only when everything passes.
function finalPolicy(run, snapshot, waitAction) {
  const s = run.state, r = readiness(snapshot, s.target.headOid);
  if (r.unresolved.length) { s.nextAction = 'the owner dispositions the external findings, then a fresh run'; s.operatorActions = `disposition and resolve ${r.unresolved.length} external review thread(s)`; run.stop('WAITING_FOR_OWNER', `unresolved external finding(s): ${r.unresolved.join('; ')}`); }
  if (r.failed.length) { s.nextAction = 'the author addresses the failure, then a fresh run'; run.stop('BLOCKED', `final policy failed: ${r.failed.join('; ')}`); }
  if (r.pending.length) { s.nextAction = waitAction; run.stop('WAITING_EXTERNAL_REVIEW', `pending: ${r.pending.join('; ')}`); }
  // What only a human or GitHub settles never holds readiness back; the operator's actions name it (CL-D100).
  s.activeGate = 'none'; s.nextAction = 'human merge decision; the workflow never merges'; s.operatorActions = r.confirm.length ? `before merging, a human confirms: ${r.confirm.join('; ')}` : 'none; a human may merge';
}

// Ignored paths a validation, a gate, or a writer changed since the run took them (review-only.md, autofix.md): a list
// of up to five, or null.
function ignoredDrift(saved, cwd) {
  const now = ignoredInventory(cwd), drift = [...now.filter((x) => !saved.includes(x)), ...saved.filter((x) => !now.includes(x))];
  return drift.length ? drift.slice(0, 5).join(', ') : null;
}
// The gates that returned MERGE on the head the run ends on, by label, for the MERGE_READY reason.
function readyGates(gateLog, head) { return [...new Set(gateLog.filter((g) => g.head === head && g.verdict === 'MERGE').map((g) => gateLabel(g.gate)))].join(' and '); }

module.exports = { TRUSTED, sendBack, failure, gateLabel, ignoredDrift, readyGates, bindTarget, guard, readIssue, trustedComments, isRecorded, readGate, collectSnapshotEvidence, sameSpec, finalPolicy };

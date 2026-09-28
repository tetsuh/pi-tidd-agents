'use strict';

// CL-D93 (#196): the shared half of the packaged driver. A run is a directory holding state.json and every packaged
// operation's request and result, numbered. Operations go through the package's own helper CLI, so each request is
// normalized and shape-checked exactly as any caller's would be; the driver composes, the helpers decide.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const PACKAGE = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(PACKAGE, 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const LANGUAGE_PROFILE = 'conversation=Japanese; github.issue=en; github.pull_request=en; external_sites={}';
const ROLE = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' };

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function die(message) { process.stderr.write(`tidd-driver: ${message}\n`); process.exit(2); }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[a.slice(2)] = value; } else out._.push(a);
  }
  return out;
}
function git(cwd, list, encoding = 'utf8') {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '--no-pager', ...list], { cwd, encoding, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } });
}
function gh(list, cwd) {
  const r = spawnSync('gh', list, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GH_PAGER: 'cat' } });
  if (r.status !== 0) throw new Error(`gh ${list.slice(0, 3).join(' ')} failed: ${(r.stderr || '').slice(0, 500)}`);
  return JSON.parse(r.stdout);
}
// The bytes a gate's contractInput hashes: the authority files of this package that the gate reads, in order.
function contractInput(files) {
  return sha256(Buffer.from(files.map((file) => `${file}\n${fs.readFileSync(path.join(PACKAGE, file), 'utf8').replace(/\r\n?/g, '\n')}`).join('\n'), 'utf8'));
}
// Acceptance criteria are the bullets of the issue's `Acceptance criteria` section; none is a stop, not a guess.
function acceptanceCriteria(body) {
  const section = (String(body || '').replace(/\r\n?/g, '\n').split(/\n##+\s*Acceptance criteria\s*\n/i)[1] || '').split(/\n##+ /)[0];
  return section.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, '').trim());
}
// Validation commands come from `.tidd.json` at the base commit, so the change under review cannot choose them.
function validationCommands(cwd, baseOid) {
  let text;
  try { text = git(cwd, ['show', `${baseOid}:.tidd.json`]); } catch { return { problem: 'the base commit carries no .tidd.json naming the validation commands' }; }
  let config;
  try { config = JSON.parse(text); } catch { return { problem: '.tidd.json at the base commit is not JSON' }; }
  const ok = config && Array.isArray(config.validate) && config.validate.length > 0 && config.validate.every((c) => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string' && a.length > 0));
  return ok ? { commands: config.validate } : { problem: '.tidd.json must carry validate: a nonempty list of nonempty argv lists' };
}

// The six head fingerprints (CL-D9), each through its packaged operation, so a value and its record are the helper's
// own answer (CONV-199-CLI-FINGERPRINT-BOUNDARY). Returns the values and the evidence records keyed by domain.
function headFingerprints(run, { cwd, baseOid, headOid, issue, comments }) {
  const diff = git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${baseOid}...${headOid}`], 'buffer');
  const commits = git(cwd, ['log', '--reverse', '--format=%H%x00%B%x01', `${baseOid}..${headOid}`]).split('\u0001').filter((x) => x.trim())
    .map((record) => { const [oid, message] = record.replace(/^\n/, '').split('\u0000'); return { oid, message }; });
  const requests = {
    issue_spec: ['fingerprint_issue_spec', { body: issue.body || '', comments }],
    pr_base: ['fingerprint_pr_base', { oid: baseOid }],
    pr_tree: ['fingerprint_pr_tree', { oid: git(cwd, ['rev-parse', `${headOid}^{tree}`]).trim() }],
    pr_diff: ['fingerprint_pr_diff', { base64: diff.toString('base64') }],
    pr_commits: ['fingerprint_pr_commits', { commits }],
    pr_head: ['fingerprint_pr_head', { oid: headOid }],
  };
  const values = {}, records = {};
  for (const [domain, [operation, payload]] of Object.entries(requests)) { const d = run.op(operation, payload).data; values[domain] = d.fingerprint; records[domain] = d.record; }
  return { values, records, diff };
}
function snapshotFingerprint(run, snapshot) {
  const d = run.op('fingerprint_snapshot', run.op('build_fingerprint_snapshot', { snapshot }).data.request.data).data;
  return { value: d.fingerprint, record: d.record };
}

// The run directory holds state and payload pointers, so it never lies inside a Git work tree, judged by where it
// resolves (CONV-199-RUN-DIR-WRITE); checked before anything is created.
function runDirProblem(dir) {
  let at = path.resolve(dir);
  while (!fs.existsSync(at)) at = path.dirname(at);
  for (let real = fs.realpathSync.native(at); ; real = path.dirname(real)) {
    if (fs.existsSync(path.join(real, '.git'))) return `the run directory ${dir} is inside a Git work tree (${real})`;
    if (real === path.dirname(real)) return null;
  }
}
// The pull request as GitHub reports it now, against the identity the run bound (CONV-199-STALE-TARGET).
function targetMoved(target, pull) {
  const now = { baseOid: pull.base?.sha, headOid: pull.head?.sha, headRepository: pull.head?.repo?.full_name, headBranch: pull.head?.ref, state: pull.state, draft: pull.draft };
  const was = { baseOid: target.baseOid, headOid: target.headOid, headRepository: target.headRepository, headBranch: target.headBranch, state: 'open', draft: false };
  const moved = Object.keys(was).filter((k) => now[k] !== was[k]);
  return moved.length ? `the target moved: ${moved.map((k) => `${k} ${was[k]} -> ${now[k]}`).join(', ')}` : null;
}
// A role as the runner reported it, in the contracted `role provider/model:thinking` form (CONV-199-STATUS-TELEMETRY).
function roleLabel(role, reported) {
  const m = /^([^/]+)\/([^:]+)(?::(.+))?$/.exec(String(reported || ''));
  return m ? `${role} ${m[1]}/${m[2]}:${m[3] || 'unreported'}` : `${role} unreported/${reported || 'unreported'}:unreported`;
}
// The identities of the external records a snapshot carries, to tell new evidence from a check changing state.
// A thread is identified by each of its comments too, so a reply or an edit inside it is new (ADV-199-THREAD-REPLY-IDENTITY).
function evidenceIds(snapshot) {
  const flat = ['comments', 'reviews', 'inline'].flatMap((kind) => (snapshot[kind] || []).map((x) => `${kind}:${x.id}:${x.updated_at || x.submitted_at || ''}`));
  const threads = (snapshot.threads || []).flatMap((th) => [`threads:${th.id}:${th.isResolved}`, ...(th.comments?.nodes || []).map((c) => `threads:${th.id}:${c.id}:${c.updatedAt || ''}`)]);
  return [...flat, ...threads].sort();
}
// Final policy from a snapshot on the head (review-only.md "Before declaring MERGE_READY"): check runs (skipped and
// neutral pass), each commit status context's latest state, each human reviewer's latest decisive review, the approvals
// branch protection and repository and organization rulesets require, CodeRabbit's classification (CL-D92), and the
// review threads still unresolved, which are external findings the owner dispositions.
// Only success, skipped, and neutral pass; the named failures fail; anything else is unknown, which is not complete.
const PASSED_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
function readiness(snapshot, headOid) {
  const failed = [], pending = [];
  for (const c of snapshot.checks || []) {
    if (c.status !== 'completed' || c.conclusion === null) pending.push(`check ${c.name}`);
    else if (FAILED_CONCLUSIONS.has(c.conclusion)) failed.push(`check ${c.name} ${c.conclusion}`);
    else if (!PASSED_CONCLUSIONS.has(c.conclusion)) pending.push(`check ${c.name} unknown conclusion ${c.conclusion}`);
  }
  const contexts = new Map();
  for (const st of [...(snapshot.statuses || [])].sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at) || x.id - y.id)) contexts.set(st.context, st);
  for (const [context, st] of contexts) {
    if (/^coderabbit$/i.test(context)) continue;
    if (st.state === 'pending') pending.push(`status ${context}`);
    else if (st.state === 'failure' || st.state === 'error') failed.push(`status ${context} ${st.state}`);
    else if (st.state !== 'success') pending.push(`status ${context} unknown state ${st.state}`);
  }
  // A required check or status context that has not reported for this head is pending (ADV-199-MISSING-REQUIRED-CHECKS).
  const pol = snapshot.policies || {};
  const requiredContexts = [...(pol.branchProtection?.required_status_checks?.contexts || []), ...(pol.branchProtection?.required_status_checks?.checks || []).map((c) => c.context),
    ...[...(pol.rulesets || []), ...(pol.organizationRulesets || [])].flatMap((r) => r.rules || []).filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks || []).map((c) => c.context))];
  const reported = new Set([...(snapshot.checks || []).map((c) => c.name), ...(snapshot.statuses || []).map((st) => st.context)]);
  for (const context of new Set(requiredContexts.filter(Boolean))) if (!reported.has(context)) pending.push(`required check ${context} has not reported`);
  for (const r of snapshot.policies?.externalReview || []) { if (r.state === 'failed') failed.push(`${r.provider} failed`); else if (r.state !== 'completed') pending.push(`${r.provider} ${r.state}`); }
  const decisive = new Map();
  for (const r of [...(snapshot.reviews || [])].sort((x, y) => Date.parse(x.submitted_at || 0) - Date.parse(y.submitted_at || 0) || x.id - y.id)) {
    if (r.user?.type === 'Bot' || !r.user?.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    decisive.set(r.user.login, r);
  }
  for (const [login, r] of decisive) if (r.state === 'CHANGES_REQUESTED') failed.push(`changes requested by ${login}`);
  const p = snapshot.policies || {};
  const fromRules = [...(p.rulesets || []), ...(p.organizationRulesets || [])].flatMap((r) => r.rules || []).filter((r) => r.type === 'pull_request').map((r) => r.parameters?.required_approving_review_count || 0);
  const required = Math.max(p.branchProtection?.required_pull_request_reviews?.required_approving_review_count || 0, ...fromRules, 0);
  const approved = [...decisive.values()].filter((r) => r.state === 'APPROVED' && (!r.commit_id || r.commit_id === headOid)).length;
  if (approved < required) pending.push(`required approvals ${approved} of ${required}`);
  // A requirement the snapshot cannot prove, such as whose approval counts or when it came, keeps readiness waiting
  // for a human to confirm it (ADV-199-CODEOWNER-APPROVAL).
  const reviewRules = [p.branchProtection?.required_pull_request_reviews || {}, ...[...(p.rulesets || []), ...(p.organizationRulesets || [])].flatMap((r) => r.rules || []).filter((r) => r.type === 'pull_request').map((r) => r.parameters || {})];
  const unverifiable = [...new Set(reviewRules.flatMap((r) => [
    (r.require_code_owner_reviews || r.require_code_owner_review) && 'a code owner\'s approval',
    r.require_last_push_approval && 'an approval after the last push',
  ]).filter(Boolean))];
  for (const what of unverifiable) pending.push(`${what} is required and cannot be verified from the snapshot`);
  const unresolved = (snapshot.threads || []).filter((th) => th.isResolved === false).map((th) => `${th.id} (${th.path || 'conversation'}, ${th.comments?.nodes?.[0]?.author?.login || 'unknown'})`);
  return { failed, pending, unresolved };
}
// A checkout the review reads must hold exactly the head: no tracked, staged, or untracked change outside the runtime
// roots (review-only.md, CL-D38/CL-D54). Ignored files, such as a validation delta, are not listed.
// A runtime root may hold untracked files only while it is absent or a real directory, judged without following a
// link; a tracked or staged change under it is a change like any other (CONV-199-CLD54-RUNTIME-ROOT-FILTER).
const RUNTIME_ROOTS = ['.pi', '.pi-subagents'];
// The checkout the review reads: at the bound head, and clean (CONV-199-POST-VALIDATION-HEAD joins the two checks).
function checkoutProblem(cwd, headOid) {
  const local = git(cwd, ['rev-parse', 'HEAD']).trim();
  return local === headOid ? dirtyCheckout(cwd) : `the checkout is at ${local}, not the public head ${headOid}`;
}
function dirtyCheckout(cwd) {
  for (const root of RUNTIME_ROOTS) {
    let stat = null; try { stat = fs.lstatSync(path.join(cwd, root)); } catch { /* absent is allowed */ }
    if (stat && !stat.isDirectory()) return `the runtime root ${root} is not a directory`;
  }
  const records = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const dirty = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]; if (!record) continue;
    const code = record.slice(0, 2), file = record.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1; // the rename or copy source follows
    const underRoot = RUNTIME_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
    if (code === '??' && underRoot) continue;
    dirty.push(file);
  }
  return dirty.length ? `the checkout is not clean: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}` : null;
}

class Run {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : { seq: 0, log: [] };
  }
  static open(opts) { return new Run(path.resolve(opts['run-dir'] || die('--run-dir is required'))); }
  save() { fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }); }
  file(name, value) {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p, Buffer.isBuffer(value) || typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return p;
  }
  // One packaged operation through the helper CLI, recorded. A refusal ends the run with `status` unless `allowFail`.
  op(operation, data, { status = 'BLOCKED', allowFail = false } = {}) {
    const n = String(++this.state.seq).padStart(3, '0');
    const request = { version: 1, operation, data };
    this.file(`${n}-${operation}.request.json`, request);
    const r = spawnSync(process.execPath, [CLI], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, cwd: os.tmpdir() });
    let result;
    try { result = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { result = { ok: false, operation, error: { code: 'cli_unparsable', message: String(r.stderr || r.stdout).slice(0, 2000) } }; }
    this.file(`${n}-${operation}.result.json`, result);
    const ok = result.ok === true && result.data?.ok !== false;
    this.state.log.push({ n, operation, ok, ...(ok ? {} : { code: result.error?.code || result.data?.code }) });
    this.save();
    if (!ok && !allowFail) this.stop(status, `${operation} refused: ${result.error?.code || result.data?.code} ${result.error?.message || ''}`.trim());
    return result;
  }
  stop(state, reason) {
    Object.assign(this.state, { state, reason, pending: null });
    this.save();
    this.publish();
    process.stdout.write(`${JSON.stringify({ state, reason, runDir: this.dir })}\n`);
    process.exit(state === 'MERGE_READY' ? 0 : 1);
  }
  // Status block and publication artifacts: the CL-D33 template and the CL-D45 marker, with a real observation time.
  publish() {
    const s = this.state, t = s.target; if (!t) return;
    const unknown = 'not computed', fp = s.fingerprints || {}, observed = s.observedFrom || s.startedAt;
    // The contracted block (review-only.md): gates are named sol and terra, the head is its OID, one finding per line.
    const label = { adversarial: 'sol', safety: 'terra' };
    const findings = (s.findings || []).map((f) => `  ${f.findingId}: ${f.disposition}`);
    const block = ['```tidd-status', `target: ${t.repository}#${t.number}`, `head_branch: ${t.headBranch}`, `mode: ${s.mode}`, `state: ${s.state}`, `active_gate: ${label[s.activeGate] || s.activeGate || 'none'}`,
      `fingerprints: issue_spec ${fp.issue_spec || unknown} base ${fp.pr_base || unknown} tree ${fp.pr_tree || unknown} diff ${fp.pr_diff || unknown} commits ${fp.pr_commits || unknown} head ${t.headOid}`,
      `rounds: ${s.rounds || 'none'}`, `resolved: ${(s.resolved || []).join('; ') || 'none'}`, findings.length ? `findings:\n${findings.join('\n')}` : 'findings: none',
      'review_misses: none', `pending_decisions: ${(s.pendingDecisions || []).join(', ') || 'none'}`, `publication_grant: ${s.grant || 'review-only not-applicable'}`,
      `external_observation: head ${t.headOid} observed_from ${observed}, this run only`, `operator_actions: ${s.operatorActions || 'none'}`, `invalidated_evidence: ${s.invalidated || 'none'}`, `next_action: ${s.nextAction || 'owner decision'}`, '```'].join('\n');
    const gates = (s.gateLog || []).map((g) => `- ${g.gate} ${g.invocation} on \`${g.head.slice(0, 12)}\`: ${g.verdict}${g.findings ? `; ${g.findings}` : ''}`).join('\n') || '- none';
    const visible = [`# Review state: ${s.state}`, '', `Pull request: https://github.com/${t.repository}/pull/${t.number}`, `Reviewed public head: \`${t.headOid}\``,
      `External observation for this run: head \`${t.headOid}\` observed at ${observed}; ${s.external || 'no snapshot was taken'}.`, '',
      `Reason: ${s.reason || s.state}.`, '', '## Gates', gates, '', `Validation: ${s.validation || 'not run'}.`, '', block, ''].join('\n');
    const marker = `<!-- pi-tidd-agents:review-publication:v1 repo=${t.repository} pr=${t.number} head=${t.headOid} visibleSha256=${sha256(visible)} -->`;
    const body = `${visible}${marker}\n`;
    // Inside the run directory, which was verified outside every work tree before it was created.
    const pub = fs.mkdtempSync(path.join(this.dir, 'publish.'));
    fs.writeFileSync(path.join(pub, 'review-comment.md'), body, { mode: 0o600 });
    const template = fs.readFileSync(path.join(PACKAGE, 'skills', 'closed-loop-pr', 'references', 'publish-review.sh'), 'utf8');
    const script = template.replaceAll('__PI_REVIEW_REPOSITORY__', t.repository).replaceAll('__PI_REVIEW_PR_NUMBER__', String(t.number)).replaceAll('__PI_REVIEW_HEAD__', t.headOid)
      .replaceAll('__PI_REVIEW_PR_URL__', `https://github.com/${t.repository}/pull/${t.number}`).replaceAll('__PI_REVIEW_BODY_SHA256__', sha256(body)).replaceAll('__PI_REVIEW_MARKER__', marker);
    fs.writeFileSync(path.join(pub, 'publish-review.sh'), script, { mode: 0o600 });
    // CL-D33 drafts exactly two artifacts; the block also lives in the run's state and in the report below.
    s.statusBlock = block;
    s.publication = { comment: path.join(pub, 'review-comment.md'), script: path.join(pub, 'publish-review.sh') };
    this.save();
    // The CL-D33 report: both paths, the body digest, the one command, and the head binding; the operator runs it.
    process.stdout.write(`FINISHED comment=${s.publication.comment}\nPUBLISH=${s.publication.script}\nbody sha256 ${sha256(body)}\nrepository ${t.repository}, pull request #${t.number}, head ${t.headOid}\n`
      + `To publish, the operator runs: bash "${s.publication.script}"\nThe comment is bound to that head; a changed head requires fresh review. It is posted under the operator's own GitHub account.\n${block}\n`);
  }
  // Print the one call the parent makes, and the command that reads its result.
  next(request, command) {
    process.stdout.write(`NEXT: make exactly this subagent call, then run: node ${command} --run-dir ${this.dir} --run-id <runId>\n${JSON.stringify(request)}\n`);
  }
}

module.exports = { Run, headFingerprints, snapshotFingerprint, runDirProblem, targetMoved, roleLabel, evidenceIds, readiness, dirtyCheckout, checkoutProblem, PACKAGE, ROLE, LANGUAGE_PROFILE, sha256, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands };

'use strict';

// CL-D93 (#196): the shared half of the packaged driver. A run is a directory holding state.json and every packaged
// operation's request and result, numbered. Operations go through the package's own helper CLI, so each request is
// normalized and shape-checked exactly as any caller's would be; the driver composes, the helpers decide.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { sanitizedEnv } = require('../helpers/process');
const { readiness, externalTiming } = require('./readiness');

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
// The driver's own Git reads run in the helpers' sanitized Git environment, so an inherited redirection (GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, …) never moves them off the checkout; `gh`, which resolves the repository through Git,
// drops the same redirection and keeps its own credentials (CONV-199-GIT-ENV-CHECKOUT).
const REDIRECT_ENV = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/i;
function git(cwd, list, encoding = 'utf8') {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '--no-pager', ...list], { cwd, encoding, maxBuffer: 256 * 1024 * 1024, env: sanitizedEnv({ LC_ALL: 'C' }, 'git') });
}
function gh(list, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !REDIRECT_ENV.test(key)));
  const r = spawnSync('gh', list, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...env, GH_PAGER: 'cat' } });
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
  // Records are framed by NUL, which Git never stores in a message (ADV-199-COMMIT-FRAME-CONTROL).
  const commits = git(cwd, ['log', '-z', '--reverse', '--format=%H%n%B', `${baseOid}..${headOid}`]).split('\u0000').filter(Boolean)
    .map((record) => { const at = record.indexOf('\n'); return { oid: record.slice(0, at), message: record.slice(at + 1) }; });
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
  const now = { baseOid: pull.base?.sha, baseBranch: pull.base?.ref, headOid: pull.head?.sha, headRepository: pull.head?.repo?.full_name, headBranch: pull.head?.ref, state: pull.state, draft: pull.draft };
  const was = { baseOid: target.baseOid, baseBranch: target.baseBranch, headOid: target.headOid, headRepository: target.headRepository, headBranch: target.headBranch, state: 'open', draft: false };
  const moved = Object.keys(was).filter((k) => now[k] !== was[k]);
  return moved.length ? `the target moved: ${moved.map((k) => `${k} ${was[k]} -> ${now[k]}`).join(', ')}` : null;
}
// A role as the runner reported it, in the contracted `role provider/model:thinking` form (CONV-199-STATUS-TELEMETRY).
// The runner records the thinking level in its own field; a model suffix is the fallback (CONV-199-ROLE-THINKING-STATUS).
function roleLabel(role, reported, thinking) {
  const m = /^([^/]+)\/([^:]+)(?::(.+))?$/.exec(String(reported || ''));
  const level = (typeof thinking === 'string' && thinking) || m?.[3] || 'unreported';
  return m ? `${role} ${m[1]}/${m[2]}:${level}` : `${role} unreported/${reported || 'unreported'}:${level}`;
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
// The ignored paths outside the runtime roots and every descendant of an ignored directory, each with its type judged
// without following a link and its content (a file's SHA-256, a link's target). Frozen after validation (the validation
// sandbox delta) and compared at every later boundary (CONV-199-IGNORED-DELTA-BOUNDARY, ADV-199-IGNORED-DELTA-CHILDREN).
function ignoredInventory(cwd) {
  const entries = git(cwd, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']).split('\0').filter((e) => e.startsWith('!! ')).map((e) => e.slice(3).replace(/\/$/, ''));
  const out = [];
  const visit = (rel) => {
    const abs = path.join(cwd, rel);
    let st; try { st = fs.lstatSync(abs); } catch { out.push(`${rel}:absent`); return; }
    if (st.isSymbolicLink()) out.push(`${rel}:symlink:${fs.readlinkSync(abs)}`);
    else if (st.isDirectory()) { out.push(`${rel}:dir`); for (const name of fs.readdirSync(abs).sort()) visit(`${rel}/${name}`); }
    else if (st.isFile()) out.push(`${rel}:file:${sha256(fs.readFileSync(abs))}`);
    else out.push(`${rel}:other`);
  };
  for (const p of entries.filter((e) => !RUNTIME_ROOTS.some((root) => e === root || e.startsWith(`${root}/`)))) visit(p);
  return out.sort();
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

// The single next permitted action when a stop names none of its own.
const NEXT_ACTION = { BLOCKED: 'address the cause, then a fresh run', ROUND_LIMIT_REACHED: 'owner decision, then a fresh run', WAITING_FOR_OWNER: 'owner decision, then a fresh run' };
// Untrusted text (reasons, commands, GitHub text) goes into the visible comment; the publisher refuses a command
// substitution or a carriage return in it, so both are neutralised to keep every draft publishable.
// A value quoted from outside the driver (a branch name, a command, a gate's or GitHub's text) is one line and never
// carries the publisher's observation marker, which only the driver's own observation fields may carry
// (ADV-199-DRAFT-OBSERVATION-TOKEN). It is folded first exactly as the publisher folds before it scans: zero-width
// characters dropped, and every space it folds, NEL included, made one ASCII space (ADV-199-PUBLISH-NEL).
function quoted(value) {
  return String(value).replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\r\n\t\v\f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .replace(/observed(_| +)(from|at)/gi, 'observed-$2');
}
function publishable(text) { return text.replace(/\r/g, '').replace(/\$(?=[({])/g, '$ '); }
// Every run artifact is written without following a link at its final path, so a link planted in the run directory
// cannot redirect a write outside it (CONV-199-RUN-DIR-SYMLINK-WRITE).
function writeOwn(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}
// A given run directory must be absent or an empty real directory, so nothing in it predates the run.
function runDirNotFresh(dir) {
  let st; try { st = fs.lstatSync(dir); } catch { return null; }
  if (!st.isDirectory()) return `the run directory ${dir} is not a directory`;
  return fs.readdirSync(dir).length ? `the run directory ${dir} is not empty; give a fresh one` : null;
}
class Run {
  constructor(dir) {
    this.dir = dir;
    // One driver command at a time holds a run, from before it reads the state until it exits; another is refused
    // before it reads or writes anything (SAFETY-199-CONCURRENT-RESULT).
    const lock = path.join(dir, 'lock');
    try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') die(`another driver command holds this run (${lock}); wait for it to finish, or remove the lock once no driver process runs`); throw error; }
    // The lock this process took is released on exit from here on, and at once if the rest of the construction fails
    // (SAFETY-199-LOCK-CONSTRUCTION).
    const release = () => fs.rmSync(lock, { recursive: true, force: true });
    process.on('exit', release);
    try {
      const fd = fs.openSync(path.join(lock, 'pid'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      this.statePath = path.join(dir, 'state.json');
      this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : { seq: 0, log: [] };
    } catch (error) {
      release(); process.removeListener('exit', release);
      throw new Error(`cannot hold the run ${dir}: ${error.message}`);
    }
  }
  // Every command that opens a run judges its directory as start does, before the lock or any write (CONV-199-RUN-DIR-OPEN-CHECK).
  static open(opts) {
    const dir = path.resolve(opts['run-dir'] || die('--run-dir is required'));
    const problem = runDirProblem(dir); if (problem) die(problem);
    return new Run(dir);
  }
  save() { writeOwn(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`); }
  file(name, value) {
    const p = path.join(this.dir, name);
    writeOwn(p, Buffer.isBuffer(value) || typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
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
    const findings = (s.findings || []).map((f) => `  ${quoted(f.findingId)}: ${quoted(f.disposition)}`);
    const block = publishable(['```tidd-status', `target: ${t.repository}#${t.number}`, `head_branch: ${quoted(t.headBranch)}`, `mode: ${s.mode}`, `state: ${s.state}`, `active_gate: ${label[s.activeGate] || s.activeGate || 'none'}`,
      `fingerprints: issue_spec ${fp.issue_spec || unknown} base ${fp.pr_base || unknown} tree ${fp.pr_tree || unknown} diff ${fp.pr_diff || unknown} commits ${fp.pr_commits || unknown} head ${t.headOid}`,
      `rounds: ${s.rounds || 'none'}`, `resolved: ${quoted((s.resolved || []).join('; ') || 'none')}`, findings.length ? `findings:\n${findings.join('\n')}` : 'findings: none',
      'review_misses: none', `pending_decisions: ${quoted((s.pendingDecisions || []).join(', ') || 'none')}`, `publication_grant: ${s.grant || 'review-only not-applicable'}`,
      `external_observation: head ${t.headOid} observed_from ${observed}, this run only`, `operator_actions: ${quoted(s.operatorActions || 'none')}`, `invalidated_evidence: ${quoted(s.invalidated || 'none')}`, `next_action: ${quoted(s.nextAction || NEXT_ACTION[s.state] || 'owner decision')}`, '```'].join('\n'));
    const gates = (s.gateLog || []).map((g) => `- ${g.gate} ${g.invocation} on \`${g.head.slice(0, 12)}\`: ${quoted(g.verdict)}${g.findings ? `; ${quoted(g.findings)}` : ''}`).join('\n') || '- none';
    const visible = publishable([`# Review state: ${s.state}`, '', `Pull request: https://github.com/${t.repository}/pull/${t.number}`, `Reviewed public head: \`${t.headOid}\``,
      `External observation for this run: head \`${t.headOid}\` observed at ${observed}; ${s.external || 'no snapshot was taken'}.`, '',
      `Reason: ${quoted(s.reason || s.state)}.`, '', '## Gates', gates, '', `Validation: ${quoted(s.validation || 'not run')}.`, '', block, ''].join('\n'));
    const marker = `<!-- pi-tidd-agents:review-publication:v1 repo=${t.repository} pr=${t.number} head=${t.headOid} visibleSha256=${sha256(visible)} -->`;
    const body = `${visible}${marker}\n`;
    // Inside the run directory, which was verified outside every work tree before it was created.
    const pub = fs.mkdtempSync(path.join(this.dir, 'publish.'));
    writeOwn(path.join(pub, 'review-comment.md'), body);
    const template = fs.readFileSync(path.join(PACKAGE, 'skills', 'closed-loop-pr', 'references', 'publish-review.sh'), 'utf8');
    const script = template.replaceAll('__PI_REVIEW_REPOSITORY__', t.repository).replaceAll('__PI_REVIEW_PR_NUMBER__', String(t.number)).replaceAll('__PI_REVIEW_HEAD__', t.headOid)
      .replaceAll('__PI_REVIEW_PR_URL__', `https://github.com/${t.repository}/pull/${t.number}`).replaceAll('__PI_REVIEW_BODY_SHA256__', sha256(body)).replaceAll('__PI_REVIEW_MARKER__', marker);
    writeOwn(path.join(pub, 'publish-review.sh'), script);
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

module.exports = { externalTiming, Run, headFingerprints, snapshotFingerprint, runDirProblem, runDirNotFresh, targetMoved, roleLabel, readiness, dirtyCheckout, checkoutProblem, ignoredInventory, PACKAGE, ROLE, LANGUAGE_PROFILE, sha256, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands };

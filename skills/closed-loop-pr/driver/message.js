'use strict';

// CL-D116 (#281): the correction commit's subject is the parent's, written before the writer launches and checked here
// against the repository's commit convention; the driver appends the issue number and the bullet body.

const { die } = require('./run');
const { guard } = require('./phases');
const { bullets } = require('./writer');

const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const WORD = /^[a-z0-9][a-z0-9._/-]*$/;
// The `commit` key of `.tidd.json` at the base, else of the operator configuration (CL-D97's files, never the head's);
// `operator` reads that configuration alone. Every key is optional, none other is accepted, and no key means the default.
function readConvention(validation, operator) {
  const own = validation.config?.commit !== undefined || validation.source === 'operator configuration', r = own ? validation : operator(), c = r.config?.commit;
  if (r.problem && !('config' in r)) return { problem: r.problem };
  if ('config' in r && (!r.config || typeof r.config !== 'object' || Array.isArray(r.config))) return { problem: `the ${r.source} must be a JSON object` };
  const bad = (why) => ({ problem: `the commit convention in ${r.source} ${why}` });
  if (c === undefined) return { convention: { types: TYPES, scope: 'optional' }, source: 'default' };
  if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('must be an object');
  const extra = Object.keys(c).find((k) => !['types', 'scope', 'scopes', 'maxLength'].includes(k));
  if (extra !== undefined) return bad(`has an unknown key ${JSON.stringify(extra)}`);
  for (const k of ['types', 'scopes']) if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].length && c[k].every((w) => typeof w === 'string' && WORD.test(w)))) return bad(`${k} must be a nonempty list of words of lowercase letters, digits and ._/-`);
  if (c.scope !== undefined && !['required', 'optional'].includes(c.scope)) return bad('scope must be required or optional');
  if (c.maxLength !== undefined && !(Number.isInteger(c.maxLength) && c.maxLength >= 30 && c.maxLength <= 200)) return bad('maxLength must be an integer from 30 to 200');
  return { convention: { types: c.types || TYPES, scope: c.scope || 'optional', scopes: c.scopes, maxLength: c.maxLength }, source: r.source };
}

// What is wrong with the subject, or null. Imperative mood is the gates' to judge; nothing else is checked here.
function subjectProblem(subject, c, issue, ids) {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(subject)) return 'the subject is one line of printable text';
  const m = /^([a-z0-9][a-z0-9._/-]*)(?:\(([^()\s]+)\))?!?: (\S(?:.*\S)?)$/u.exec(subject);
  if (!m) return 'the subject is <type>(<scope>): <summary> or <type>: <summary>';
  if (!c.types.includes(m[1])) return `the type is one of ${c.types.join(', ')}`;
  if (m[2] === undefined && c.scope === 'required') return 'the scope is required';
  if (m[2] !== undefined && c.scopes && !c.scopes.includes(m[2])) return `the scope is one of ${c.scopes.join(', ')}`;
  if (/\.$|\(#\d+\)/.test(m[3])) return 'the summary ends without a period and carries no (#<n>) reference; the driver appends the issue number';
  if (ids.some((id) => m[3].includes(id))) return 'the summary describes the change, not a finding id';
  if (c.maxLength && `${subject} (#${issue})`.length > c.maxLength) return `the subject with " (#${issue})" is at most ${c.maxLength} characters`;
  return null;
}

// Ask the parent for the subject: the command, the convention, and the corrections it summarises.
function askSubject(run, open, self, why, refused = 0) {
  const s = run.state, c = s.convention;
  Object.assign(s, { pending: { kind: 'message', head: s.target.headOid, findings: open.map((e) => e.findingId), refused }, activeGate: 'writer', state: 'MESSAGE_PENDING' });
  run.save();
  process.stdout.write(`MESSAGE: ${why ? `refused (${why}); ` : ''}write the commit subject for these corrections, then run: node ${self} message --run-dir ${run.dir} --subject <the subject, quoted for your shell>
Convention (${s.conventionSource}): <type>${c.scope === 'required' ? '(<scope>)' : '[(<scope>)]'}: <imperative summary>; type ${c.types.join('|')}${c.scopes ? `; scope ${c.scopes.join('|')}` : ''}${c.maxLength ? `; at most ${c.maxLength} characters with " (#${s.issueNumber})"` : ''}; the driver appends " (#${s.issueNumber})"; no finding id, no trailing period.
${bullets(open)}\n`);
  process.exit(0);
}

// `message`: the subject checked, then the writer launch; the third refusal stops the run BLOCKED, before any commit.
function takeSubject(opts, { openRun, end, launchWriter, self }) {
  const run = openRun(opts), s = run.state, p = s.pending;
  if (p?.kind !== 'message') die('no commit subject is pending in this run');
  if (typeof opts.subject !== 'string') die('--subject is required');
  guard(run);
  const open = s.ledger.filter((e) => p.findings.includes(e.findingId)), why = subjectProblem(opts.subject, s.convention, s.issueNumber, p.findings);
  if (!why) return launchWriter(run, open, opts.subject);
  if (p.refused + 1 >= 3) end(run, 'BLOCKED', `commit_subject_refused: ${why}`);
  return askSubject(run, open, self, why, p.refused + 1);
}

module.exports = { readConvention, subjectProblem, askSubject, takeSubject };

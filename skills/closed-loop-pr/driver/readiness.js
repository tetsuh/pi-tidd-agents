'use strict';

// CL-D93 (#196): the external half of review-only readiness, split from run.js without change so each driver file
// stays under its alarm: the final policy over a snapshot, and the quiet period and observation window.

// Final policy from a snapshot on the head (review-only.md "Before declaring MERGE_READY"): check runs (skipped and
// neutral pass), each commit status context's latest state, each human reviewer's latest decisive review, the approvals
// branch protection and repository and organization rulesets require, CodeRabbit's classification (CL-D92), and the
// review threads still unresolved, which are external findings the owner dispositions.
// A ruleset counts when it is active, targets branches, and its conditions select this pull request's base branch and
// repository (CONV-199-RULESET-APPLICABILITY). A condition the snapshot cannot evaluate, such as a repository property,
// counts, so an unknown targeting keeps readiness waiting rather than passing it.
function glob(pattern) { return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`); }
function selects(condition, value, special) {
  if (!condition || value === undefined) return true;
  const hit = (list) => (list || []).some((p) => special(p) ?? glob(p).test(value));
  return hit(condition.include) && !hit(condition.exclude);
}
function applicable(ruleset, snapshot) {
  if (ruleset.enforcement !== 'active' || (ruleset.target && ruleset.target !== 'branch')) return false;
  const c = ruleset.conditions || {}, after = snapshot.after || {}, fallback = snapshot.policies?.defaultBranch;
  const ref = after.baseBranch && `refs/heads/${after.baseBranch}`;
  const name = after.repository && after.repository.split('/')[1];
  return selects(c.ref_name, ref, (p) => (p === '~ALL' ? true : p === '~DEFAULT_BRANCH' ? !fallback || ref === `refs/heads/${fallback}` : undefined))
    && selects(c.repository_name, name, (p) => (p === '~ALL' ? true : undefined));
}
// Only success, skipped, and neutral pass; the named failures fail; anything else is unknown, which is not complete.
const PASSED_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
// The ruleset conditions the snapshot can evaluate; any other key (a repository property, a repository id list) leaves
// whether the ruleset applies unknown, which a human confirms (CONV-199-RULESET-UNCERTAINTY).
const KNOWN_CONDITIONS = new Set(['ref_name', 'repository_name']);
function readiness(snapshot, headOid) {
  const failed = [], pending = [];
  for (const r of [...(snapshot.policies?.rulesets || []), ...(snapshot.policies?.organizationRulesets || [])].filter((x) => applicable(x, snapshot))) {
    const unknown = Object.keys(r.conditions || {}).filter((k) => !KNOWN_CONDITIONS.has(k));
    if (unknown.length) pending.push(`ruleset ${r.name || r.id} has a condition the snapshot cannot evaluate (${unknown.join(', ')}); a human confirms whether it applies`);
  }
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
  // A requirement pinned to an app (protection `app_id`, ruleset `integration_id`; -1 or none accepts any source) is
  // met only by that app's check run, never by another app's or a legacy status (ADV-199-REQUIRED-APP-ID).
  const pol = snapshot.policies || {}, rsc = pol.branchProtection?.required_status_checks || {};
  // Protection's legacy contexts and its checks both count; a pinned check stays pinned beside an unpinned context
  // of the same name, since each requirement is met on its own (ADV-199-LEGACY-CONTEXT-OMITTED).
  const requiredChecks = [...(rsc.contexts || []).map((context) => ({ context })), ...(Array.isArray(rsc.checks) ? rsc.checks.map((c) => ({ context: c.context, app: c.app_id })) : []),
    ...[...(pol.rulesets || []), ...(pol.organizationRulesets || [])].filter((r) => applicable(r, snapshot)).flatMap((r) => r.rules || []).filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks || []).map((c) => ({ context: c.context, app: c.integration_id })))];
  const reported = new Set([...(snapshot.checks || []).map((c) => c.name), ...(snapshot.statuses || []).map((st) => st.context)]);
  const seen = new Set();
  for (const { context, app } of requiredChecks.filter((r) => r.context)) {
    const pinned = typeof app === 'number' && app !== -1, key = `${context}\0${pinned ? app : ''}`;
    if (seen.has(key)) continue; seen.add(key);
    const met = pinned ? (snapshot.checks || []).some((c) => c.name === context && c.app?.id === app) : reported.has(context);
    if (!met) pending.push(`required check ${context}${pinned ? ` from app ${app}` : ''} has not reported`);
  }
  for (const r of snapshot.policies?.externalReview || []) { if (r.state === 'failed') failed.push(`${r.provider} failed`); else if (r.state !== 'completed') pending.push(`${r.provider} ${r.state}`); }
  const decisive = new Map();
  for (const r of [...(snapshot.reviews || [])].sort((x, y) => Date.parse(x.submitted_at || 0) - Date.parse(y.submitted_at || 0) || x.id - y.id)) {
    if (r.user?.type === 'Bot' || !r.user?.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    decisive.set(r.user.login, r);
  }
  for (const [login, r] of decisive) if (r.state === 'CHANGES_REQUESTED') failed.push(`changes requested by ${login}`);
  const p = snapshot.policies || {};
  const rules = [...(p.rulesets || []), ...(p.organizationRulesets || [])].filter((r) => applicable(r, snapshot)).flatMap((r) => r.rules || []);
  const fromRules = rules.filter((r) => r.type === 'pull_request').map((r) => r.parameters?.required_approving_review_count || 0);
  const required = Math.max(p.branchProtection?.required_pull_request_reviews?.required_approving_review_count || 0, ...fromRules, 0);
  const approved = [...decisive.values()].filter((r) => r.state === 'APPROVED' && r.commit_id === headOid).length;
  if (approved < required) pending.push(`required approvals ${approved} of ${required}`);
  // A requirement the snapshot cannot prove, such as whose approval counts or when it came, keeps readiness waiting
  // for a human to confirm it (ADV-199-CODEOWNER-APPROVAL).
  const reviewRules = [p.branchProtection?.required_pull_request_reviews || {}, ...rules.filter((r) => r.type === 'pull_request').map((r) => r.parameters || {})];
  const unverifiable = [...new Set(reviewRules.flatMap((r) => [
    (r.require_code_owner_reviews || r.require_code_owner_review) && 'a code owner\'s approval',
    r.require_last_push_approval && 'an approval after the last push',
  ]).filter(Boolean))];
  for (const what of unverifiable) pending.push(`${what} is required and cannot be verified from the snapshot`);
  const unresolved = (snapshot.threads || []).filter((th) => th.isResolved === false).map((th) => `${th.id} (${th.path || 'conversation'}, ${th.comments?.nodes?.[0]?.author?.login || 'unknown'})`);
  return { failed, pending, unresolved };
}
// review-only.md: a two-minute quiet period after the latest external event (ADV-199-THREAD-QUIET-UNTIMED: or the latest observed change), and a fifteen-minute observation window
// from this run's first snapshot of the head; both are this run's own and are reported as such.
const QUIET_MS = 2 * 60 * 1000, WINDOW_MS = 15 * 60 * 1000;
function externalTiming(snapshot, origin, now = Date.now(), changedAt = null) {
  const times = [...(snapshot.comments || []).map((c) => c.updated_at || c.created_at), ...(snapshot.inline || []).map((c) => c.updated_at || c.created_at), ...(snapshot.reviews || []).map((r) => r.submitted_at),
    ...(snapshot.threads || []).flatMap((th) => (th.comments?.nodes || []).map((c) => c.updatedAt || c.createdAt)), ...(snapshot.checks || []).map((c) => c.completed_at || c.started_at),
    ...(snapshot.statuses || []).map((st) => st.updated_at || st.created_at)].map((v) => Date.parse(v));
  // A change the run observed without an event time of its own (a thread resolved) is timed when it was observed.
  if (changedAt) times.push(Date.parse(changedAt));
  // A record without a valid event time cannot place the quiet period, so it keeps readiness waiting (fail closed).
  const undated = times.filter((v) => !Number.isFinite(v)).length;
  if (undated) times.splice(0, times.length, ...times.filter((v) => Number.isFinite(v)));
  const latest = times.length ? Math.max(...times) : null, quietUntil = latest === null ? null : latest + QUIET_MS, windowEnds = Date.parse(origin) + WINDOW_MS;
  const iso = (v) => new Date(v).toISOString();
  return { quiet: undated ? `quiet period unknown: ${undated} external record(s) carry no valid event time` : quietUntil !== null && now < quietUntil ? `quiet period until ${iso(quietUntil)} after the latest external event at ${iso(latest)}` : null, windowEnded: now >= windowEnds,
    report: `quiet period ${latest === null ? 'not started (no external event)' : `2 minutes after ${iso(latest)}`}; observation window 15 minutes from ${origin}, ${now >= windowEnds ? 'ended' : `until ${iso(windowEnds)}`}; this run only` };
}

module.exports = { readiness, externalTiming };

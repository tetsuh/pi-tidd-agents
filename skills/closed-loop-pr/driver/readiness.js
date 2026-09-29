'use strict';

// CL-D93 (#196): the external half of review-only readiness, split from run.js without change so each driver file
// stays under its alarm: the final policy over a snapshot, and the quiet period and observation window.

// Final policy from a snapshot on the head (review-only.md "Before declaring MERGE_READY"): check runs (skipped and
// neutral pass), each commit status context's latest state, branch protection's required checks, each human reviewer's
// latest decisive review, CodeRabbit's classification (CL-D92), and the review threads still unresolved, which are
// external findings the owner dispositions.
// What the snapshot cannot settle exactly waits for a human and never passes (owner decision,
// https://github.com/tetsuh/pi-tidd-agents/issues/196#issuecomment-5892010180): the driver never decides whether a
// ruleset applies or whether approvals satisfy one. Every ruleset not known disabled that carries a rule besides those
// that never gate a merge waits, whatever its targeting reads, and so does every enabled branch-protection setting the
// driver does not evaluate, its review requirements included.
const NON_GATING_RULES = new Set(['deletion', 'non_fast_forward', 'creation']);
const PROTECTION_SETTLED = new Set(['url', 'required_status_checks', 'enforce_admins', 'allow_force_pushes', 'allow_deletions', 'block_creations', 'required_linear_history', 'required_conversation_resolution', 'allow_fork_syncing']);
function humanConfirms(snapshot) {
  const out = [], p = snapshot.policies || {};
  for (const r of [...(p.rulesets || []), ...(p.organizationRulesets || [])]) {
    if (r?.enforcement === 'disabled') continue;
    const gating = Array.isArray(r?.rules) ? [...new Set(r.rules.map((x) => x?.type ?? 'an unreadable rule').filter((t) => !NON_GATING_RULES.has(t)))] : ['unreadable rules'];
    if (gating.length) out.push(`ruleset ${r?.name || r?.id} can gate the merge (${gating.join(', ')}); a human confirms it`);
  }
  const bp = p.branchProtection;
  const unsettled = bp && typeof bp === 'object' ? Object.entries(bp).filter(([k, v]) => !PROTECTION_SETTLED.has(k) && v !== null && v !== false && v?.enabled !== false).map(([k]) => k) : [];
  // A strict required-checks setting asks that the head be up to date with the base, which the driver does not settle
  // (CONV-199-STRICT-REQUIRED-CHECKS).
  if (bp && typeof bp === 'object' && bp.required_status_checks?.strict === true) unsettled.push('required_status_checks.strict (the head up to date with the base)');
  if (unsettled.length) out.push(`branch protection requires ${unsettled.join(', ')}; a human confirms it`);
  return out;
}
// Only success, skipped, and neutral pass; the named failures fail; anything else is unknown, which is not complete.
const PASSED_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
// GitHub's own mergeability, which any reader sees, settles what an unreadable protection or ruleset would hide (a
// protection read answers 404 to a non-admin), a head behind its base, and a merge conflict; anything but a mergeable
// state waits.
const MERGEABLE_STATES = new Set(['clean', 'unstable', 'has_hooks']);
function readiness(snapshot, headOid) {
  const failed = [], pending = [...humanConfirms(snapshot)];
  const state = snapshot.pull?.mergeable_state ?? null;
  if (!MERGEABLE_STATES.has(state)) pending.push(`GitHub reports the pull request mergeable_state ${state}${state === 'dirty' ? ' (a merge conflict)' : ''}; it must be clean, unstable, or has_hooks`);
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
  // A requirement pinned to an app (protection `app_id`; -1 or none accepts any source) is
  // met only by that app's check run, never by another app's or a legacy status (ADV-199-REQUIRED-APP-ID).
  const pol = snapshot.policies || {}, rsc = pol.branchProtection?.required_status_checks || {};
  // Protection's legacy contexts and its checks both count; a pinned check stays pinned beside an unpinned context
  // of the same name, since each requirement is met on its own (ADV-199-LEGACY-CONTEXT-OMITTED).
  const requiredChecks = [...(rsc.contexts || []).map((context) => ({ context })), ...(Array.isArray(rsc.checks) ? rsc.checks.map((c) => ({ context: c.context, app: c.app_id })) : [])];
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
    // A bot's request for changes blocks like a human's; approvals are not counted at all (the #196 cut-off).
    if (!r.user?.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    decisive.set(r.user.login, r);
  }
  for (const [login, r] of decisive) if (r.state === 'CHANGES_REQUESTED') failed.push(`changes requested by ${login}`);
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

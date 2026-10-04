'use strict';

// CL-D93 (#196): the external half of review-only readiness, split from run.js so each driver file stays under its
// alarm: the final policy over a snapshot, and what the run observed of external review.

// Final policy from a snapshot on the head (review-only.md "Before declaring MERGE_READY"): check runs (skipped and
// neutral pass), each commit status context's latest state, branch protection's required checks, each human reviewer's
// latest decisive review, and the review threads still unresolved, which are external findings the owner dispositions.
// External review is best effort (CL-D100, #226): a finding that is present is answered, and nothing waits for one that
// may still come. An external review provider's state (CL-D92) is reported as observed, never waited for.
// What the snapshot cannot settle exactly is for a human to confirm before merging and never holds readiness back: the
// driver never decides whether a ruleset applies or whether approvals satisfy one. Every ruleset not known disabled
// that carries a rule besides those that never gate a merge is named, whatever its targeting reads, and so is every
// enabled branch-protection setting the driver does not evaluate, its review requirements included.
const { REVIEW_APP } = require('../helpers/snapshot');
const NON_GATING_RULES = new Set(['deletion', 'non_fast_forward', 'creation']);
// Settled: required checks and conversation resolution are evaluated here (the latter through unresolved threads); the
// rest never gate a merge. Everything else enabled, required linear history included, is named (ADV-199-LINEAR-HISTORY-PROTECTION).
const PROTECTION_SETTLED = new Set(['url', 'required_status_checks', 'required_conversation_resolution', 'enforce_admins', 'allow_force_pushes', 'allow_deletions', 'block_creations', 'allow_fork_syncing']);
function humanConfirms(snapshot) {
  const out = [], p = snapshot.policies || {};
  for (const r of [...(p.rulesets || []), ...(p.organizationRulesets || [])]) {
    if (r?.enforcement === 'disabled') continue;
    const gating = Array.isArray(r?.rules) ? [...new Set(r.rules.map((x) => x?.type ?? 'an unreadable rule').filter((t) => !NON_GATING_RULES.has(t)))] : ['unreadable rules'];
    if (gating.length) out.push(`ruleset ${r?.name || r?.id} can gate the merge (${gating.join(', ')})`);
  }
  const bp = p.branchProtection;
  const unsettled = bp && typeof bp === 'object' ? Object.entries(bp).filter(([k, v]) => !PROTECTION_SETTLED.has(k) && v !== null && v !== false && v?.enabled !== false).map(([k]) => k) : [];
  // A strict required-checks setting asks that the head be up to date with the base, which the driver does not settle
  // (CONV-199-STRICT-REQUIRED-CHECKS).
  if (bp && typeof bp === 'object' && bp.required_status_checks?.strict === true) unsettled.push('required_status_checks.strict (the head up to date with the base)');
  if (unsettled.length) out.push(`branch protection requires ${unsettled.join(', ')}`);
  return out;
}
// Only success, skipped, and neutral pass; the named failures fail; anything else is unknown, which is not complete.
const PASSED_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
// GitHub's own mergeability, which any reader sees, settles what an unreadable protection or ruleset would hide (a
// protection read answers 404 to a non-admin), a head behind its base, and a merge conflict. `blocked` is a requirement
// only a human or GitHub settles, so it is named; any other state that is not mergeable waits.
const MERGEABLE_STATES = new Set(['clean', 'unstable', 'has_hooks']);
function readiness(snapshot, headOid) {
  const failed = [], pending = [], confirm = humanConfirms(snapshot);
  const state = snapshot.pull?.mergeable_state ?? null;
  if (state === 'blocked') confirm.push('GitHub reports the pull request mergeable_state blocked');
  else if (!MERGEABLE_STATES.has(state)) pending.push(`GitHub reports the pull request mergeable_state ${state}${state === 'dirty' ? ' (a merge conflict)' : ''}; it must be clean, unstable, or has_hooks`);
  const pol = snapshot.policies || {}, rsc = pol.branchProtection?.required_status_checks || {};
  // Protection's legacy contexts and its checks both count; a pinned check stays pinned beside an unpinned context
  // of the same name, since each requirement is met on its own (ADV-199-LEGACY-CONTEXT-OMITTED).
  const requiredChecks = [...(rsc.contexts || []).map((context) => ({ context })), ...(Array.isArray(rsc.checks) ? rsc.checks.map((c) => ({ context: c.context, app: c.app_id })) : [])];
  // A check run or commit status an external review provider posts, which no protection requires, is part of that
  // review: observed. One that protection requires keeps the rule of every required check; a requirement pinned to
  // an app is that app's check run only, never another app's and never a status (CONV-227-PINNED-REVIEW-CHECK-001).
  const pin = (r) => typeof r.app === 'number' && r.app !== -1, required = (name, app) => requiredChecks.some((r) => r.context === name && (!pin(r) || r.app === app));
  const observed = (pol.externalReview || []).map((r) => `${r.provider} ${r.state}`);
  for (const c of snapshot.checks || []) {
    if (c.app?.slug === REVIEW_APP && !required(c.name, c.app.id)) { observed.push(`check ${c.name} ${c.status === 'completed' ? c.conclusion : c.status}`); continue; }
    if (c.status !== 'completed' || c.conclusion === null) pending.push(`check ${c.name}`);
    else if (FAILED_CONCLUSIONS.has(c.conclusion)) failed.push(`check ${c.name} ${c.conclusion}`);
    else if (!PASSED_CONCLUSIONS.has(c.conclusion)) pending.push(`check ${c.name} unknown conclusion ${c.conclusion}`);
  }
  const contexts = new Map();
  for (const st of [...(snapshot.statuses || [])].sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at) || x.id - y.id)) contexts.set(st.context, st);
  for (const [context, st] of contexts) {
    // Exempt only as the provider's own: the creator CL-D92's classification requires (SAFETY-227-STATUS-SOURCE-001).
    if (/^coderabbit$/i.test(context) && st.creator?.login === 'coderabbitai[bot]' && !required(context)) continue;
    if (st.state === 'pending') pending.push(`status ${context}`);
    else if (st.state === 'failure' || st.state === 'error') failed.push(`status ${context} ${st.state}`);
    else if (st.state !== 'success') pending.push(`status ${context} unknown state ${st.state}`);
  }
  // A required check or status context that has not reported for this head is pending (ADV-199-MISSING-REQUIRED-CHECKS).
  // A requirement pinned to an app (protection `app_id`; -1 or none accepts any source) is
  // met only by that app's check run, never by another app's or a legacy status (ADV-199-REQUIRED-APP-ID).
  const reported = new Set([...(snapshot.checks || []).map((c) => c.name), ...(snapshot.statuses || []).map((st) => st.context)]);
  const seen = new Set();
  for (const { context, app } of requiredChecks.filter((r) => r.context)) {
    const pinned = pin({ app }), key = `${context}\0${pinned ? app : ''}`;
    if (seen.has(key)) continue; seen.add(key);
    const met = pinned ? (snapshot.checks || []).some((c) => c.name === context && c.app?.id === app) : reported.has(context);
    if (!met) pending.push(`required check ${context}${pinned ? ` from app ${app}` : ''} has not reported`);
  }
  const decisive = new Map();
  for (const r of [...(snapshot.reviews || [])].sort((x, y) => Date.parse(x.submitted_at || 0) - Date.parse(y.submitted_at || 0) || x.id - y.id)) {
    // A bot's request for changes blocks like a human's; approvals are not counted at all (the #196 cut-off).
    if (!r.user?.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    decisive.set(r.user.login, r);
  }
  for (const [login, r] of decisive) if (r.state === 'CHANGES_REQUESTED') failed.push(`changes requested by ${login}`);
  const unresolved = (snapshot.threads || []).filter((th) => th.isResolved === false).map((th) => `${th.id} (${th.path || 'conversation'}, ${th.comments?.nodes?.[0]?.author?.login || 'unknown'})`);
  return { failed, pending, unresolved, confirm, observed };
}
// What the run observed of external activity, reported and never waited for (CL-D100): the latest external event, and
// how many records carry no valid event time.
function externalEvents(snapshot) {
  const times = [...(snapshot.comments || []).map((c) => c.updated_at || c.created_at), ...(snapshot.inline || []).map((c) => c.updated_at || c.created_at), ...(snapshot.reviews || []).map((r) => r.submitted_at),
    ...(snapshot.threads || []).flatMap((th) => (th.comments?.nodes || []).map((c) => c.updatedAt || c.createdAt)), ...(snapshot.checks || []).map((c) => c.completed_at || c.started_at),
    ...(snapshot.statuses || []).map((st) => st.updated_at || st.created_at)].map((v) => Date.parse(v));
  const dated = times.filter((v) => Number.isFinite(v)), undated = times.length - dated.length;
  return `${dated.length ? `latest external event at ${new Date(Math.max(...dated)).toISOString()}` : 'no external event'}${undated ? `, ${undated} record(s) without a valid event time` : ''}; external review is not waited for`;
}

module.exports = { readiness, externalEvents };

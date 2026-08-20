# Review-only mode

## Review-only is the default (AC-REVIEW-ONLY, CL-D15)

For the whole review-only run:

- do not edit any file in the repository, tracked or untracked, apart from `VALIDATION_SANDBOX_DELTA` below;
- do not change git state;
- do not commit or push;
- do not post to GitHub;
- do not reply to review threads;
- do not mutate any external service.

You may inspect, review, disposition findings, and draft replies/patches.

### Validation sandbox boundary (CL-D38)

Review-only runs in the operator checkout and runs validation there, so validation may create ignored caches. Freeze them as `VALIDATION_SANDBOX_DELTA` at the boundary that first observes them. Every later boundary permits only that exact presence delta: any tracked change, index change, ref movement, unsafe root, or non-validation untracked path still stops the run as `BLOCKED`. Review-only creates the delta by running validation and nothing else; the freeze grants no cleanup, publication, commit, push, or reply authority, so the observed caches are left exactly as validation left them.

### Candidate evidence boundary (CL-D23, CL-D9)

Review-only never edits any repository file or creates a working-tree candidate. Drafts stay outside the repository; no post-fix formal gate consumes an uncommitted overlay.

### Target stability during a run (CL-D27)

Review-only has no publication phase and no local commit/push window. Revalidate the target and its evidence before each gate; refuse to continue against a changed target without cleaning, normalizing, or discarding anything, and report what moved instead.

## Publication boundary (CL-D28)

Issue workflow has no publication grant through this Skill, and PR review-only has no publication grant through this PR path. Issue publication authority, when present, originates only from the CL-D31 exception in the shared Issue Skill for `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>`; it does not originate from `/tidd-pr` or this Skill. Review-only never commits, pushes, posts, replies, or mutates external state. It may draft a proposed commit message, replies, and disposition summary for the operator. **Drafting is not publishing.**

### Guarded owner publication artifacts (CL-D33, Issue #41)

At each summary stop, read sibling `publish-review.sh` completely, copies it byte-for-byte, replaces all six exact ASCII placeholders once, and follows its Generation contract. Draft exactly two UTF-8/LF artifacts—`review-comment.md` and `publish-review.sh`—in a fresh external `mktemp` directory; Review-only never executes the script. CL-D33 aggregate-summary publication is optional, not a locally drafted correction candidate, never blocks `MERGE_READY`, and does not create `WAITING_FOR_OWNER`; only an outstanding readiness-relevant unpublished correction candidate has that effect. Report paths/digest, repository/PR/head, exact command `bash "<path>/publish-review.sh"`, `changed head requires fresh review`, `publication_grant: review-only not-applicable`, and operator attribution. The owner executing that command is the publication grant; artifacts remain external drafts.

## Gate loop (PR review-only baseline; AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The following gate loop and its disposition/fix handoff are the PR review-only baseline.

The order is fixed and sequential:

```text
implementation and validation
→ one initial external-review snapshot for the current `pr_head`
→ sol-reviewer gate
→ disposition, fix, revalidate
→ Sol MERGE
→ terra-reviewer gate
→ disposition, fix, revalidate
→ Terra MERGE
→ external finding disposition
→ exact-head checks
→ MERGE_READY
```

Each review-only gate payload composes the shared Every-gate invariant payload block verbatim, exactly one selected PR root role-authority block verbatim, and the volatile envelope/history projection; Sol additionally composes the shared Sol-only adversarial invariant payload block verbatim. `sol-reviewer` owns contracts, scope, maintainability, test coverage, and the bounded adversarial check below. `terra-reviewer` then owns concurrency, lifetime, ownership, cleanup, portability, deadlocks, races, and use-after-free risk. **Never start the Terra gate before the Sol gate returns `MERGE`.**

### Review-only round deltas (CL-D11, CL-D12)

The shared gate contract supplies the common three-round, passing-round, failure-consumption, and run-scoped accounting. Review-only adds these deltas:

- A gate rerun caused by a fix consumes a round from that gate's budget.
- If a Terra finding forces a change to something Sol already approved, the Sol gate must run again and consumes one of its own rounds. The same applies to a fix that originates from an external finding.
- At the limit, stop and report `ROUND_LIMIT_REACHED` and ask the owner whether to grant more rounds.
- A missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`.

## External review (PR review-only baseline; CL-D18, CL-D24, CL-D17)

The following quiet-period, observation-reporting, Sonar handoff, and resumable external-review procedure applies to PR review-only. External gates apply only to pull-request readiness, and only through what is observable on the pull request with `gh`.

Detection is limited to reviews, comments, and checks present on the current `pr_head`. A service that has produced none of those is **not detected** and is reported as such, never as passed and never as failed. Distinguish not configured, configured but not started, pending, completed without findings, completed with findings, failed, stale for an older head, and authentication or rate-limit failure. Never treat an unknown state as success.

Observation policy, which this MVP reports against rather than enforces:

- before the first Sol invocation, take exactly one initial external-review snapshot of reviews, comments, and checks for the current `pr_head` using `gh`; this snapshot is the observation origin;
- a **two-minute quiet period** after the latest external event;
- a **fifteen-minute** maximum observation window per head, measured from that initial snapshot (a new head starts a new origin);
- a new head resets both.

**External evidence is never carried across runs.** Each run takes its own snapshot; no pasted status resumes it. Report quiet/window only for this run, as current-process snapshots.

This narrows `DEC-EXT-SNAPSHOT-001`: **provider-native finding identity** for reviews, inline review comments, issue comments, check runs and commit statuses, with edit timestamps/head association, belongs to external-review integration, not this prose; CL-D28 draws the same publication boundary.

When an external state cannot be determined — a provider that exposes no usable identity, a missing timestamp, a record with no head association — report it as **unknown, not complete**, and stay `WAITING_EXTERNAL_REVIEW`. An undetermined provider is never a passing one.

Workflow findings carry across resumptions with assigned identities and status dispositions. The initial snapshot is not polling. Review-only has no timers and **must not busy-poll**; incomplete processing reports `WAITING_EXTERNAL_REVIEW` with a status block for resume.

Treat CodeRabbit and SonarCloud as required once detected. Process GitHub Copilot review findings when observed, but never block merely because an optional Copilot review is absent. Human `Changes requested` and required approvals are a separate repository-policy gate.

### SonarCloud (CL-D17)

PR review-only has no SonarCloud credentials or API integration, so it **cannot perform provider-side status transitions**. It dispositions each Sonar finding and drafts the Accepted rationale in the configured SonarCloud language, plus a summary in the pull-request language, for the operator.

PR review-only `MERGE_READY` **must not be declared on the basis of a transition that was never performed**. Report remaining owner actions in review-only.

## Outcome and status block (PR review-only baseline; CL-D13, CL-D14)

Use these tokens exactly:

```text
MERGE_READY
WAITING_EXTERNAL_REVIEW
WAITING_FOR_OWNER
ROUND_LIMIT_REACHED
BLOCKED
ABORTED
```

In PR review-only, **never declare `MERGE_READY` while a locally drafted candidate is unpublished**; this means a readiness-relevant correction candidate and stops at `WAITING_FOR_OWNER`. Once published, a fresh run revalidates the target and external evidence, then reruns Sol, Terra, external state, and exact-head checks.

Before declaring `MERGE_READY`, refresh external findings, required human-review state, and required checks against the current `pr_head`. A new finding, a failed check, `Changes requested`, or a new head revokes readiness. `MERGE_READY` means the pull request is ready for a human to merge; never merge it yourself.

Whenever a PR review-only run stops, emit the resumable block below:

````text
```tidd-status
target: <owner/repo#123>
head_branch: <branch>
mode: review-only
state: <token>
active_gate: <sol|terra|external|none>
fingerprints: issue_spec <d> base <d> tree <d> diff <d> commits <d> head <sha>
rounds: sol <used>/3, terra <used>/3
findings: <internal finding id: disposition, one per line>
pending_decisions: <decision ids or none>
publication_grant: review-only not-applicable
external_observation: head <sha> observed_from <timestamp>, this run only
operator_actions: <what the operator must do to publish, or none>
invalidated_evidence: <what must be redone>
next_action: <the single next permitted action>
```
````

PR review-only may resume when the operator pastes that block back with the command; **revalidate the fingerprints** first. Refuse to continue against a changed target without cleaning, normalizing, or discarding anything, and report what moved instead. Recompute rather than trusting pasted state: a pasted digest is a claim, not evidence.

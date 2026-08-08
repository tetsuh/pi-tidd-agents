# Review-only mode

## Review-only is the default (AC-REVIEW-ONLY, CL-D15)

Unless the exact token `autofix` was supplied, for the whole run:

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not commit or push;
- do not post to GitHub;
- do not reply to review threads;
- do not mutate any external service.

You may inspect, review, disposition findings locally, and draft proposed replies and patches. Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**.

## Gate loop (PR review-only baseline; AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The following gate loop and its disposition/fix handoff are the PR review-only baseline. Exact PR `autofix` uses only the CL-D30 addendum and does not inherit this loop's publication or candidate behavior.

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

`sol-reviewer` owns contracts, scope, maintainability, test coverage, and the bounded adversarial check below. `terra-reviewer` then owns concurrency, lifetime, ownership, cleanup, portability, deadlocks, races, and use-after-free risk. **Never start the Terra gate before the Sol gate returns `MERGE`.**

### Round accounting (CL-D11, PR review-only baseline)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- A gate rerun caused by a fix consumes a round from that gate's budget.
- If a Terra finding forces a change to something Sol already approved, the Sol gate must run again and consumes one of its own rounds. The same applies to a fix that originates from an external finding.
- At the limit, stop and report `ROUND_LIMIT_REACHED` and ask the owner whether to grant more rounds.

Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block. **Do not create a state file** to work around this; persistent workflow state is a later stage.

## External review (PR review-only baseline; CL-D18, CL-D24, CL-D17)

The following quiet-period, observation-reporting, Sonar handoff, and resumable external-review procedure applies to PR review-only. Exact PR `autofix` uses the current-process snapshots and fail-stop policy in the CL-D30 addendum. External gates apply only to pull-request readiness, and only through what is observable on the pull request with `gh`.

Detection is limited to reviews, comments, and checks present on the current `pr_head`. A service that has produced none of those is **not detected** and is reported as such, never as passed and never as failed. Distinguish not configured, configured but not started, pending, completed without findings, completed with findings, failed, stale for an older head, and authentication or rate-limit failure. Never treat an unknown state as success.

Observation policy, which this MVP reports against rather than enforces:

- before the first Sol invocation, take exactly one initial external-review snapshot of reviews, comments, and checks for the current `pr_head` using `gh`; this snapshot is the observation origin;
- a **two-minute quiet period** after the latest external event;
- a **fifteen-minute** maximum observation window per head, measured from that initial snapshot (a new head starts a new origin);
- a new head resets both.

**External evidence is never carried across runs.** A resumed or later run takes its own snapshot and reprocesses what it sees; nothing external is read from a pasted status block. The window and quiet period are therefore reported for the current run's observation only, and the report says so rather than implying a longer continuous watch.

This is a narrowing of `DEC-EXT-SNAPSHOT-001`, which kept the origin and compared findings by stable identity. Making that work needs a **provider-native finding identity** for reviews, inline review comments, issue comments, check runs and commit statuses, plus edit timestamps and head association per source. That is provider correlation logic, and it belongs to the external-review integration issue rather than to this MVP's prose — the same boundary CL-D28 drew for publication.

When an external state cannot be determined — a provider that exposes no usable identity, a missing timestamp, a record with no head association — report it as **unknown, not complete**, and stay `WAITING_EXTERNAL_REVIEW`. An undetermined provider is never a passing one.

In PR review-only, findings the workflow raises itself carry across resumptions: Sol and Terra findings have identities this workflow assigns, so the status block lists each with its disposition. Exact PR `autofix` is run-local only and never resumes. The review-only initial snapshot is not polling and does not delay internal review. Review-only has no timers and **must not busy-poll** or spend turns waiting; when processing has not completed, report `WAITING_EXTERNAL_REVIEW` with a status block and let the operator resume. Exact autofix stops instead.

Treat CodeRabbit and SonarCloud as required once detected. Process GitHub Copilot review findings when observed, but never block merely because an optional Copilot review is absent. Human `Changes requested` and required approvals are a separate repository-policy gate.

### SonarCloud (CL-D17)

PR review-only has no SonarCloud credentials or API integration, so it **cannot perform provider-side status transitions**. It dispositions each Sonar finding and drafts the Accepted rationale in the configured SonarCloud language, plus a summary in the pull-request language, for the operator. Exact PR `autofix` never calls Sonar/provider mutation APIs and does not treat an absent transition as success.

PR review-only `MERGE_READY` **must not be declared on the basis of a transition that was never performed**. Exact PR `autofix` follows its own final-policy and source-reply requirements in CL-D30. Report remaining owner actions in review-only.

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

In PR review-only, **never declare `MERGE_READY` while a locally drafted candidate is unpublished**. Review-only drafts are outside the repository and any outstanding operator publication action ends at `WAITING_FOR_OWNER`; after the operator publishes, a fresh review-only run reruns Sol, Terra, external state, and exact-head checks. Exact PR `autofix` has no uncommitted candidate and may report readiness only from the CL-D30 post-reply final snapshot; its optional aggregate-summary draft never blocks readiness.

Before declaring `MERGE_READY`, refresh external findings, required human-review state, and required checks against the current `pr_head`. A new finding, a failed check, `Changes requested`, or a new head revokes readiness. `MERGE_READY` means the pull request is ready for a human to merge; never merge it yourself.

Whenever a PR review-only run stops, emit the resumable block below. Exact PR `autofix` reports its non-resumable CL-D30 status instead and never emits a resume action:

````text
```tidd-status
target: <owner/repo#123>
head_branch: <branch>
mode: <review-only|autofix>
state: <token>
active_gate: <sol|terra|external|none>
fingerprints: issue_spec <d> base <d> tree <d> diff <d> commits <d> head <sha>
rounds: sol <used>/3, terra <used>/3
findings: <internal finding id: disposition, one per line>
pending_decisions: <decision ids or none>
publication_grant: <review-only not-applicable | autofix bounded CL-D30 grant>
external_observation: head <sha> observed_from <timestamp>, this run only
operator_actions: <what the operator must do to publish, or none>
invalidated_evidence: <what must be redone>
next_action: <the single next permitted action>
```
````

PR review-only may resume when the operator pastes that block back with the command; **revalidate the fingerprints** first. Exact PR `autofix` never resumes: a later command is a fresh run. In either mode, refuse to continue against a changed target without cleaning, normalizing, or discarding anything, and report what moved instead. Recompute rather than trusting pasted state: a pasted digest is a claim, not evidence.

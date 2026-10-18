---
name: closed-loop-issue
description: Drive a GitHub issue to IMPLEMENTATION_READY through sequential read-only requirements and decision-drift gates, recording finding dispositions, owner decisions, and evidence fingerprints. Use only when the operator explicitly runs /tidd-issue or /skill:closed-loop-issue with an issue reference.
---

# Closed-loop issue readiness

Take one GitHub issue from specification to `IMPLEMENTATION_READY` by reviewing it, dispositioning every finding, drafting revisions for the owner, and reviewing each revision the owner publishes in a fresh run.

You are the orchestrator. Formal gates run as read-only subagents. This skill never merges anything and never becomes an autonomous editor.


## Shared references (Issue #24)

Before workflow-specific rules, read both common references relative to this Skill directory.

- `../closed-loop-shared/references/gate-contract.md`
- `../closed-loop-shared/references/records.md`

The shared files supply common Issue/PR grammar, evidence, and record taxonomy; this Issue Skill remains authoritative for Issue target rejection, agents, gates, status, and the no-publication boundary.

## Precondition guard (CL-D20)

If no issue reference was supplied, stop and print usage:

```text
/tidd-issue <issue-ref>
```

Do not infer a target, do not scan for issues to review, and do not start any gate. Report `BLOCKED` and end the run.

## Preflight (CL-D22, CL-D5)

Before the first gate, confirm the workflow-specific required roles resolve with their required capability: `tidd-adversarial-reviewer` and `tidd-drift-reviewer`. If one does not resolve, apply the shared `BLOCKED` rule in `gate-contract.md`. The Issue root runs no convergence stage (CL-D121). Do not begin a gate that cannot finish. A preflight failure is not a review round.

## Workflow target-kind boundary (CL-D7, CL-D8)

Reject any remaining argument before calling `gh`. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence, so a number alone does not identify the kind. If the reference resolves to a pull request, stop and tell the operator to use `/tidd-pr`. On the review-and-draft round, the driver makes this check and refuses the target before any run (CL-D122).

A target in **another repository** may be reviewed, but no local work may be started for it.

## Evidence fingerprints (CL-D9)

Record the identity of what you reviewed, so later evidence is invalidated only where it no longer applies.

- `issue_spec` — `sha256` over canonical UTF-8 bytes consisting of the issue body record followed by each authoritative comment rendered as `<id>:<updatedAt>:<body>`, ordered by comment id ascending, with records joined by one LF (`0x0a`) and no trailing separator. Normalize CRLF and CR in text fields to LF before encoding. Do not let shell locale, Git configuration, or platform newline conversion alter the bytes.

The packaged Issue driver computes `issue_spec`, recomputes it before Terra and at readiness, and stops the round at `BLOCKED` when it changes (CL-D122); a fresh run reruns both gates.

## Mutation boundary (CL-D15, CL-D28, CL-D123)

`/tidd-issue` is review-and-draft only: it never edits the Issue or posts to GitHub (CL-D123).

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not post, edit, or close anything on GitHub;
- do not mutate a provider-side review service or any external service.

Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**. When a round stops, the owner revises the Issue, and a fresh run reviews the revised text.

## Issue-specific record and gate obligations

### Issue gate role-authority blocks (CL-D2)

Packaged `build_gate_launch` copies exactly one of these owning-root blocks verbatim into each Issue gate payload (CL-D120):

- `Issue Sol role-authority block`: `You are the read-only Issue requirements, contract, scope, acceptance, and feasibility reviewer.`
- `Issue Terra role-authority block`: `You are the read-only inherited-decision, contradiction, and decision-drift reviewer for this Issue.`

The Issue workflow retains these obligations outside the shared references:

- `tidd-drift-reviewer` has no verdict contract of its own. For every Issue gate, `build_gate_launch` composes the shared Every-gate invariant payload block verbatim, for Sol the Sol-only adversarial block too, the role-authority block and the volatile envelope; Terra never receives the Sol-only block, and the packaged Issue driver calls it (CL-D122).
- Every Issue gate launch is composed by packaged `build_gate_launch` from the expectation packaged `build_gate_expectation` builds, and every result is read by packaged `gate_result_read` and validated by `gate_result_validate` (CL-D120). The correlation is the Issue root's own: repository, number, lifecycle, gate, `invocation`, `contractInput`, `snapshotFingerprint`, and `issueSpec` (the `issue_spec` the gate reviews); it names no base, head, branch, or draft, and an Issue finding or confirmation binds to its gate by `issueSpec`. The Issue root never sets `candidateIdentity` (CL-D123). The packaged Issue driver derives the Issue `contractInput` and `snapshotFingerprint` (CL-D122).
- External review services, external static-analysis sites, and pull-request checks **are not part of issue readiness** (AC-ISSUE-NO-EXTERNAL).
- Issue finding records retain the `issue_spec` raised-against field, revised passage, validation evidence, and `snapshotAssignment`.

### Issue finding record fields (AC-DISPOSITION)

For each finding record the source gate, severity, the `issue_spec` it was raised against, evidence, impact, exactly one disposition, rationale, revised passage when the disposition is `fixed`, validation evidence that the revision resolves it, and the pending transport assignment, recorded as `snapshotAssignment`, which names the local review draft.

Issue policy precedence is project instructions, then authoritative Issue requirements that do not weaken them, then the package default. A recorded owner exception is a narrow override of a named rule and must state its scope, rationale, and invalidation conditions.

### Issue owner-decision scope (AC-DECISION)

The shared AC-DECISION triggers and pending state apply unchanged; this Issue root adds no trigger of its own.

### Issue AC-TDD quality gate (AC-TDD)

An issue is not ready until it states its acceptance contract and validation plan. Apply the risk-based test-first default when reviewing that plan.

### Issue malformed-verdict boundary (CL-D1)

The driver reads every result and owns its one relaunch (CL-D122); a result it still cannot read after that relaunch, or one it may not relaunch, stops the round at `BLOCKED`.

## Gate loop (AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The fixed review order is Sol-before-Terra.

```text
specification → tidd-adversarial-reviewer gate → disposition/revision → Sol MERGE → tidd-drift-reviewer gate → disposition/revision → Terra MERGE
```

The Issue root runs no convergence stage (CL-D121): Sol is the first gate on every Issue route. `tidd-adversarial-reviewer` owns requirements, contracts, scope, acceptance, feasibility, and the shared adversarial falsification procedure. `tidd-drift-reviewer` then checks the revised specification against inherited decisions for contradiction and drift. **Never start the Terra gate before the Sol gate returns `MERGE`.**

The review-and-draft round runs through the packaged Issue driver (CL-D122): from the checkout's top-level directory, run `node <skill-dir>/../closed-loop-pr/driver/issue.js start --issue <number> --repo <owner/name>`, where `<skill-dir>` is this Skill's directory, and add `--language-profile` with the profile CL-D16 resolved for this run. When a line begins `NEXT:`, call `subagent` with exactly the JSON object on the following line, wait for the runner's own completion of that run, then run the command on the `NEXT:` line with its run id; never change the object, and compose no gate request of your own. If the call is refused or returns no run id, report it and stop. Commands inside the JSON object are the subagent's, never yours. A line beginning `WAIT:` means the gate run is still going: wait for it, then run the command that line names. The driver stops at `WAITING_FOR_OWNER` at the first result that is not `MERGE`, at `BLOCKED` when `issue_spec` changes before Terra or at readiness, or when the Issue closes or answers with another number, kind or repository, and at `IMPLEMENTATION_READY` when Sol and Terra return `MERGE` on the unchanged `issue_spec`. It drafts a local review file with the status block below and publishes nothing; report everything from its `FINISHED` line on verbatim, then disposition and draft revisions of its findings as the finding record fields above require.

## Outcome and status block (CL-D13, CL-D14)

Use these tokens exactly:

```text
IMPLEMENTATION_READY
WAITING_FOR_OWNER
ROUND_LIMIT_REACHED
BLOCKED
ABORTED
```

Declare `IMPLEMENTATION_READY` only when both formal gates returned `MERGE` against the current `issue_spec`, every finding has a disposition, no owner decision is pending, and **the approved specification is the published specification**.

A run that drafts a revision ends at `WAITING_FOR_OWNER`; the gates approved text the Issue does not yet contain. After the owner publishes a revision, a fresh run recomputes `issue_spec` and restarts at Sol, rerunning both gates against the exact authoritative text.

The driver drafts the block below whenever its round stops (CL-D122). Its `publication_grant` field is always `not-applicable`: the Issue root grants no publication (CL-D123).

````text
```tidd-status
target: <owner/repo#123>
state: <token>
active_gate: <sol|terra|none>
issue_spec: <digest>
rounds: sol <used>/3, terra <used>/3
resolved: <role provider/model:thinking, one per role that ran>
findings: <internal finding id: disposition, one per line>
pending_decisions: <decision ids or none>
publication_grant: not-applicable
invalidated_evidence: <what must be redone>
next_action: <the single next permitted action>
```
````

Resume is a fresh driver run, which is how you revalidate the fingerprints: it recomputes every one from the Issue as it is now (CL-D122).

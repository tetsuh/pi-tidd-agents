---
name: closed-loop-pr
description: Review a GitHub pull request toward MERGE_READY through sequential read-only requirements and safety gates, dispositioning every finding. Review-only by default; the exact token autofix delegates bounded fixes to a single worker. Use only when the operator explicitly runs /tidd-pr or /skill:closed-loop-pr with a pull-request reference.
---

# Closed-loop pull-request readiness

Take one pull request from implementation toward `MERGE_READY` by reviewing it, dispositioning every finding, applying only authorized fixes, and revalidating the exact evidence a change invalidated.

You are the orchestrator. Formal gates run as read-only subagents, at most one worker ever writes, and merge is never yours to perform.


## Shared references (Issue #24)

Before PR-specific rules, read both common references relative to this Skill directory.

- `../closed-loop-shared/references/gate-contract.md`
- `../closed-loop-shared/references/records.md`

These references own only policy that is identical across Issue and PR workflows. Workflow-specific target rejection, agents, gates, status, publication, and mode behavior remain authoritative in this Skill and the packaged driver.

## Precondition guard (CL-D20)

If no pull-request reference was supplied, stop and print usage:

```text
/tidd-pr <pr-ref> [autofix]
```

Do not infer a target and do not start any gate. Report `BLOCKED` and end the run.

## Mode parsing (CL-D6)

The mode token is the final token of the raw argument vector, evaluated once the target reference has been recognized. A target reference may itself be two tokens, such as `Issue #123` or `PR #123`, so a fixed argument position does not identify the mode. Parsing is exact and fails closed:

- the final token is exactly `autofix`, **case-sensitive** → autofix mode;
- no token remains once the target reference is consumed → review-only mode;
- anything else, including `Autofix`, `AUTOFIX`, `--autofix`, or any token still left over after the reference and an optional final `autofix` → **stop and print usage**.

A near-miss token signals intent to mutate, so it must surface as an error rather than quietly downgrade to review-only.

## Preflight (CL-D22, CL-D5)

1. Confirm that the workflow-specific required roles resolve with their required capability: `tidd-adversarial-reviewer`, `tidd-safety-reviewer`, and, conditionally for autofix mode, `tidd-autofix-worker`. `tidd-convergence-reviewer` is required in both modes for the CL-D62 convergence stage unless it is explicitly disabled: a disabled role skips the stage and reports `convergence: disabled`; a missing, unresolved, or write-capable resolution is `BLOCKED` under the shared rule.
2. If one does not resolve, apply the shared `BLOCKED` rule in `gate-contract.md`; do not begin a gate that cannot finish.

A preflight failure is not a review round.

## Workflow target-kind boundary (CL-D7, CL-D8)

The shared grammar consumes the target reference first. CL-D6 then consumes only a final exact `autofix` token; reject any leftover token or near-miss. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence. If the reference resolves to an issue, stop and tell the operator to use `/tidd-issue`.

A pull request of another repository than the current checkout's is refused before the driver: report it and stop, and review nothing (CL-D111). A pull request whose head is in **another repository** is refused by the driver before any run, as is one whose base or head commit the checkout does not hold; nothing is reviewed from the GitHub API alone (CL-D111). Autofix still requires local objects, the head branch checked out, and the `OPERATOR_CHECKOUT@H` plus `AUTOFIX_WORKSPACE@H` rules of CL-D30. Autofix and every publication action refuse such a target because publication authority is bound to the repository of the current checkout.

## Driver dispatch (CL-D104)

After the checks above, the pull request runs through the packaged driver, which sequences the round, not you. The other sections of this Skill and the shared references are the specification the driver and the gates implement; you read no mode reference, compose no helper request, and judge no finding. A pull request the driver refuses before any run (a head in another repository, or a base or head commit the checkout does not hold) is reported on its error output; report it and stop, and review nothing by hand (CL-D111).

1. From the checkout's top-level directory, run `node <skill-dir>/driver/<driver>.js start --pr <number> --repo <owner/name>`, where `<skill-dir>` is this Skill's directory, `<driver>` is `review` in review-only mode and `autofix` in autofix mode, and `<owner/name>` is the checkout's repository. Add `--language-profile "conversation=<language>; github.issue=<language>; github.pull_request=<language>; external_sites=<sites>"` with the profile CL-D16 resolved for this run (`<sites>` is `{}` when it names none), and `--convergence disabled` only when preflight found that role disabled. Set no timeout of your own on a driver command; one that is killed anyway is reported, and you stop.
2. When a line begins `NEXT:`, call `subagent` with exactly the JSON object on the following line. If the call is refused or returns no run id, report it and stop; never change the object. Otherwise wait for the runner's own completion of that run; never interrupt, pause, steer, or cancel it. Then run the command on the `NEXT:` line itself (`result` or `writer-done`) with that run id; commands inside the JSON object are the subagent's, never yours. When a line begins `MESSAGE:` instead, write the one subject line it asks for from the corrections listed under it, under the convention it states, and run the command on that line with it, quoted for your shell; you write only the subject, never the body or the issue number. A refused subject prints `MESSAGE:` again with the reason, and the third refusal stops the run (CL-D116).
3. When a line begins `WAIT:`, the run has not completed: wait for its completion, then run the command that line names with the same run id. This is not a retry.
4. Otherwise, when a line begins `FINISHED comment=`, report everything from that line to the end verbatim, and stop. Never run the publication script.
5. Otherwise, when a driver command prints none of these lines, report the last 30 lines of its combined output and stop; never retry or continue by hand.

## PR gate payload composition (CL-D2, CL-D29)

### PR gate role-authority blocks (CL-D2)

Copy exactly one of these owning-root blocks verbatim into each PR gate payload:

- `PR Sol role-authority block`: `You are the read-only PR requirements, contract, scope, correctness, and test reviewer.`
- `PR Terra role-authority block`: `You are the read-only concurrency, lifetime, ownership, cleanup, and decision-drift reviewer for this PR.`

Every PR review-only Sol/Terra invocation and every exact-autofix Sol/Terra invocation composes the shared Every-gate invariant payload block verbatim, the shared Sol-only adversarial invariant payload block verbatim for Sol (including every post-push Sol), the shared exact-autofix threat-model payload block verbatim for every exact-autofix Sol and for no review-only Sol (CL-D34), exactly one selected PR gate role-authority block verbatim, and the volatile envelope/history projection. Every convergence invocation in either mode composes the shared Every-gate invariant payload block verbatim and the volatile envelope/history projection, returns the packaged schema declared by its agent definition, with no `outputSchema` in the launch, and receives neither the Sol-only adversarial block nor a formal role-authority block (CL-D62).

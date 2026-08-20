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

These references own only policy that is identical across Issue and PR workflows. Workflow-specific target rejection, agents, gates, status, publication, and mode behavior remain authoritative in this Skill and the selected PR mode reference.

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

1. Confirm that the workflow-specific required agents resolve: `sol-reviewer`, `terra-reviewer`, and, conditionally for autofix mode, `luna-worker`.
2. If one does not resolve, apply the shared `BLOCKED` rule in `gate-contract.md`; do not begin a gate that cannot finish.

A preflight failure is not a review round.

## Workflow target-kind boundary (CL-D7, CL-D8)

The shared grammar consumes the target reference first. CL-D6 then consumes only a final exact `autofix` token; reject any leftover token or near-miss. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence. If the reference resolves to an issue, stop and tell the operator to use `/tidd-issue`.

A target in **another repository** may be reviewed in review-only mode. Its base/head OIDs, tree values, effective diff, and commit sequence come from the foreign GitHub API endpoints described below, so no local Git object or checkout is required. The same GitHub API evidence path is available to a same-repository review-only target when local Git objects are absent; this requires no fetch, checkout, or git-state mutation. Autofix still requires local objects, the head branch checked out, and the `OPERATOR_CHECKOUT@H` plus `AUTOFIX_WORKSPACE@H` rules below. Autofix and every publication action refuse such a target because publication authority is bound to the repository of the current checkout.

## Evidence fingerprints (CL-D9)

Track identity per kind of evidence, so a change invalidates only what it actually affects:

- `issue_spec` — `sha256` over the body of the issue this pull request implements, followed by its authoritative comments as `<id>:<updatedAt>:<body>`, ordered by comment id ascending;
- `pr_base` — base revision OID reported by `gh`;
- `pr_tree` — head tree OID from `git rev-parse <head>^{tree}`;
- `pr_diff` — `sha256` of the effective `base...head` diff;
- `pr_commits` — `sha256` of the ordered commit subject/body sequence;
- `pr_head` — exact head SHA, used only for CI and exact-head external checks.

Every digest uses canonical UTF-8 bytes:

- normalize CRLF and CR to LF in textual records;
- order records explicitly, join records with one LF (`0x0a`), and omit a trailing separator;
- hash binary patch bytes raw; they are never newline-normalized.

For a local target, use `LC_ALL=C`, `git -c core.autocrlf=false -c core.safecrlf=false --no-pager diff --binary --no-ext-diff --no-textconv` and the matching log options.

For a foreign review-only target, and for a same-repository review-only target whose local Git objects are absent, no checkout is required and evidence comes from the GitHub API without fetch, checkout, or git-state mutation:

- `gh api repos/<owner>/<repo>/pulls/<n>` for OIDs;
- `gh api -H 'Accept: application/vnd.github.v3.diff' repos/<owner>/<repo>/pulls/<n>` for the effective diff;
- `gh api --paginate repos/<owner>/<repo>/pulls/<n>/commits` for the commit sequence;
- `gh api repos/<owner>/<repo>/git/commits/<sha> --jq .tree.sha` for tree values.

Canonicalize JSON records before hashing. Both local and foreign paths hash the same raw effective diff bytes and use the same record serialization.

**Bracket API evidence collection**, and every gate that consumes it, with a fresh base/head read taken before and after. Independent calls are separate requests against a moving target, so without bracketing a single collection can mix OIDs, diff, and commit sequence from different revisions. If either value changed, review-only may discard the evidence and retry under its baseline policy. Exact PR `autofix` instead discards the evidence, fails closed, and stops without retry; a stale-target failure has no gate or mutation authority.

Use `printf '%s'` or an equivalent exact-byte pipeline and `sha256sum` (or an equivalent command that hashes the exact byte stream) to compute every digest.

A code review may be carried forward across a **metadata-only rewrite** only when `pr_tree` and `pr_diff` are unchanged, and the carry-forward note must name which evidence was preserved and which was invalidated. Any change to `pr_head` always invalidates CI and exact-head external evidence, even when the tree is identical.

## PR gate payload composition (CL-D2, CL-D29)

### PR gate role-authority blocks (CL-D2)

Copy exactly one of these owning-root blocks verbatim into each PR gate payload:

- `PR Sol role-authority block`: `You are the read-only PR requirements, contract, scope, correctness, and test reviewer.`
- `PR Terra role-authority block`: `You are the read-only concurrency, lifetime, ownership, cleanup, and decision-drift reviewer for this PR.`

Every PR review-only Sol/Terra invocation and every exact-autofix Sol/Terra invocation composes the shared Every-gate invariant payload block verbatim, the shared Sol-only adversarial invariant payload block verbatim for Sol (including every post-push Sol), exactly one selected PR gate role-authority block verbatim, and the volatile envelope/history projection. Review-only and exact-autofix mode references must not restate the retired all-history requirement; mode-specific correlation and safety duties remain in their owning references.

### Validation sandbox delta (CL-D38)

`VALIDATION_SANDBOX_DELTA` := the ignored paths that this run's own validation created, frozen by path, type, and no-follow presence at the boundary that observes them. Both PR modes use this one definition. The delta is observed only: its members are never read, followed, deleted, pruned, or restored, and its content never enters evidence, a fingerprint, a draft, or a status block. Freezing it grants no cleanup, publication, or mutation authority, and every boundary after the freeze permits only that exact presence delta.

## PR-specific record obligations

The PR workflow retains workflow- and mode-specific duties outside the shared references:

- PR finding records retain complete stable source identity when available: source kind, source ID, source URL, author identity and type, body digest, timestamps, review-commit association, path and line association, observed public head, fingerprint, semantic fingerprint, corrective change, validation evidence, and reply/status URL.

### PR finding source identity (AC-DISPOSITION)

For each PR finding record the complete stable source identity when available: source kind, source ID, source URL, author identity and author type, body digest, created and updated timestamps, review-commit association, path and line association, observed public head, plus severity, the fingerprint it was raised against, evidence, impact, smallest correction, semantic fingerprint, disposition, rationale, corrective change when the disposition is `fixed`, validation evidence, and reply/status URL once published. A reviewer score, severity label, or provider recommendation is never by itself a decision to change code.
- Review-only drafts findings and replies without posting; exact PR `autofix` requires a published correction commit and responsible-gate confirmation before a fixed disposition or source-finding reply.
- PR owner decisions retain review-only draft transport and exact-autofix `WAITING_FOR_OWNER(reason=owner_decision_required)` behavior.
- Merging without required deterministic coverage needs explicit owner approval; this PR-specific requirement remains in this PR Skill/root.

### PR owner-decision scope (AC-DECISION)

The shared AC-DECISION triggers and pending state apply; this PR root additionally pauses on dangerous operations, and ship decisions.
- PR external-review applicability, provider mutation boundaries, mode status, retry, no-resume, and final-readiness behavior remain in the selected mode reference.

## Mode dispatch (CL-D19)

After CL-D6 mode parsing succeeds and the shared preflight, target, evidence, language, gate, disposition, decision, and test-provenance rules above are available, load the authoritative continuation for the parsed mode:

- review-only mode: read `references/review-only.md`;
- exact CL-D30 `autofix` mode: read `references/autofix.md`.

Read exactly one mode reference after mode parsing. Never read both. Follow the selected reference together with this shared contract; no instruction from the unselected mode applies.

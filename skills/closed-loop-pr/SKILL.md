---
name: closed-loop-pr
description: Review a GitHub pull request toward MERGE_READY through sequential read-only requirements and safety gates, dispositioning every finding. Review-only by default; the exact token autofix delegates bounded fixes to a single worker. Use only when the operator explicitly runs /tidd-pr or /skill:closed-loop-pr with a pull-request reference.
---

# Closed-loop pull-request readiness

Take one pull request from implementation toward `MERGE_READY` by reviewing it, dispositioning every finding, applying only authorized fixes, and revalidating the exact evidence a change invalidated.

You are the orchestrator. Formal gates run as read-only subagents, at most one worker ever writes, and merge is never yours to perform.

## Precondition guard (CL-D20)

This skill runs only against an explicit target supplied by the operator. If no pull-request reference was supplied, stop and print usage:

```text
/tidd-pr <pr-ref> [autofix]
```

Do not infer a target and do not start any gate. Report `BLOCKED` and end the run.

## Mode parsing (CL-D6)

The mode token is the argument immediately after the target reference. Parsing is exact and fails closed:

- exactly `autofix`, **case-sensitive** → autofix mode;
- **absent or empty** → review-only mode;
- anything else, including `Autofix`, `AUTOFIX`, `--autofix`, or any extra argument beyond that position → **stop and print usage**.

A near-miss token signals intent to mutate, so it must surface as an error rather than quietly downgrade to review-only.

## Preflight (CL-D22, CL-D5)

1. Subagent execution comes from `pi-subagents`. If `pi-subagents` is unavailable, stop and report `BLOCKED` with installation guidance. Never substitute your own execution for a formal gate, and never edit files yourself in place of a worker.
2. Confirm that the required agents resolve: `sol-reviewer`, `terra-reviewer`, and, in autofix mode, `luna-worker`.
3. Refer to agents **by runtime name** only, **never by model ID**. User and project agent definitions take discovery precedence over package-provided ones with the same runtime name, so an operator whose environment lacks a model can supply their own definition under the same name.
4. If a required agent does not resolve, stop and report `BLOCKED`, naming the missing agent and the override path.

A preflight failure is not a review round.

## Target resolution (CL-D7, CL-D8)

Accept a full GitHub URL, `#123`, `123`, `Issue #123`, `PR #123`, or `PR123`.

The prompt template passes the complete raw argument vector (`$@`) to this Skill. Parse it before calling `gh`: greedily recognize `Issue`/`PR` followed by `#123` as one two-token reference, recognize the other forms as one token, and treat only a final exact `autofix` as the mode. Reject any remaining token. Resolve the reference with `gh`. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence. If the reference resolves to an issue, stop and tell the operator to use `/tidd-issue`. The target is **never inferred from the current branch**.

A target in **another repository** may be reviewed in review-only mode. Its base/head OIDs, tree values, effective diff, and commit sequence come from the foreign GitHub API endpoints described below, so no local Git object or checkout is required. Autofix and every publication action refuse such a target, because publication authority is bound to the repository of the current checkout.

## Evidence fingerprints (CL-D9)

Track identity per kind of evidence, so a change invalidates only what it actually affects:

- `issue_spec` — `sha256` over the body of the issue this pull request implements, followed by its authoritative comments as `<id>:<updatedAt>:<body>`, ordered by comment id ascending;
- `pr_base` — base revision OID reported by `gh`;
- `pr_tree` — head tree OID from `git rev-parse <head>^{tree}`;
- `pr_diff` — `sha256` of the effective `base...head` diff;
- `pr_commits` — `sha256` of the ordered commit subject/body sequence;
- `pr_head` — exact head SHA, used only for CI and exact-head external checks.

Every digest uses canonical UTF-8 bytes: normalize CRLF and CR to LF for textual records, order records explicitly, join records with one LF (`0x0a`), and omit a trailing separator. Binary patch bytes are hashed raw and are never newline-normalized. For a local target, use `LC_ALL=C`, `git -c core.autocrlf=false -c core.safecrlf=false --no-pager diff --binary --no-ext-diff --no-textconv` and the matching log options. For a foreign review-only target, use `gh api repos/<owner>/<repo>/pulls/<n>` for OIDs, `gh api -H 'Accept: application/vnd.github.v3.diff' repos/<owner>/<repo>/pulls/<n>` for the effective diff, `gh api --paginate repos/<owner>/<repo>/pulls/<n>/commits` for the commit sequence, and `gh api repos/<owner>/<repo>/git/commits/<sha> --jq .tree.sha` for tree values; canonicalize JSON records before hashing. Both local and foreign paths hash the same raw effective diff bytes and use the same record serialization. These paths require no checkout. Use `printf '%s'` or an equivalent exact-byte pipeline and `sha256sum` (or an equivalent command that hashes the exact byte stream) to compute every digest. **Never estimate or invent a digest value**: a digest you did not actually compute makes the resume check meaningless, and an unstable value raises false "target changed" alarms on a target that never moved.

An **authoritative comment** is one whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` and whose author **is not a bot**.

A code review may be carried forward across a **metadata-only rewrite** only when `pr_tree` and `pr_diff` are unchanged, and the carry-forward note must name which evidence was preserved and which was invalidated. Any change to `pr_head` always invalidates CI and exact-head external evidence, even when the tree is identical.

## Language Profile (CL-D16)

Resolve and display the destination-based profile at the start of the run. There is no configuration file in this MVP; derive it from explicit operator instruction, then project instructions, then these package defaults:

```yaml
languages:
  conversation: <the language the operator is using in this session>
  github:
    issue: en
    pull_request: en
  external_sites: {}
```

- Converse in `conversation`.
- Write pull-request titles, bodies, summaries, and review replies in `github.pull_request`. Replies posted on the pull request use the pull-request language regardless of which service raised the finding.
- Use `github.issue` for issue destinations.
- For any destination under `external_sites` that has no configured language, **stop and ask before the first post** rather than guessing.
- This profile **never governs source code**, code comments, repository documentation, or commit messages. Those follow project instructions.

## Review-only is the default (AC-REVIEW-ONLY, CL-D15)

Unless the exact token `autofix` was supplied, for the whole run:

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not commit or push;
- do not post to GitHub;
- do not reply to review threads;
- do not mutate any external service.

You may inspect, review, disposition findings locally, and draft proposed replies and patches. Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**.

## Autofix (AC-AUTOFIX, CL-D3, CL-D4, CL-D10)

`autofix` is permission to modify files. It **does not by itself authorize** commits, pushes, comments, external-service changes, history rewriting, or merge.

### Worktree precondition (CL-D10)

Autofix requires that the pull request's head branch is already checked out in the current worktree and that the tree is clean. Otherwise stop and ask the operator to run `gh pr checkout <number>` themselves. **Never switch branches**, stash, or discard work: that is a git-state change nobody authorized and it can destroy uncommitted work.

### The writer (CL-D3)

The default writer is `luna-worker`. Two constraints select it. `terra-worker` is excluded because its model **also grades the Terra gate**, and a gate verdict here is an automated exit condition rather than advice to a human, so a model must not grade its own fixes. `glm-worker`'s model does not grade a gate either, but choosing it would require a second model family on top of the reviewers', so `luna-worker`, the package's general-purpose worker, **keeps the closed-loop requirement inside one model family**.

A run has **exactly one writer**. If the writer fails to start, stop. **Do not fall back to another worker**: a partially written tree followed by a second writer breaks the single-writer guarantee. Choosing a different worker requires an explicit owner instruction in conversation; it is not a command token.

Formal reviewers are read-only and never become writers. Synthesize the findings yourself, then hand the worker one bounded instruction set.

**Never create `context.md` or `plan.md`** to brief the worker. Pass everything inline in the invocation payload. If files with those names already exist they belong to the project and are read-only inputs.

Apply only the **smallest correction** that satisfies a finding inside the approved contract. Stop before any unapproved product, API, architecture, scope, compatibility, or risk decision. After fixes, run focused validation and rerun each gate whose evidence the change invalidated.

### Candidate evidence after autofix edits (CL-D9)

Before any post-fix Sol or Terra invocation, capture the sole worker's exact uncommitted working-tree overlay. `candidate_diff` is a canonical byte record stream with this precise framing: each record is `<type>\t<pathByteLength>\t<byteLength>\t<path>\t<rawBytes>`, where type, decimal lengths, and path are UTF-8, lengths count UTF-8/path or raw-byte lengths, and rawBytes are never newline-normalized; records are separated by one LF byte (`0x0a`) with no trailing separator. Emit three fixed patch records in this order: `committed-base-head`, `staged`, and `unstaged` (each with an empty path), followed by one `untracked` record per non-ignored path sorted by UTF-8 path bytes. Capture it with `LC_ALL=C git -c core.autocrlf=false -c core.safecrlf=false --no-pager diff --binary --no-ext-diff --no-textconv <base>...HEAD`, the corresponding `--cached` and worktree diffs, and `git ls-files --others --exclude-standard -z` followed by raw-byte reads of each listed path. Hash the resulting record stream with `sha256sum` using the same explicit `LC_ALL=C` and no-text-conversion options. Include the exact candidate diff and its `candidate_diff` fingerprint in every post-fix review payload. `pr_tree` and `pr_diff` alone are insufficient because uncommitted edits do not change them. Do not commit, push, or otherwise mutate git state merely to calculate candidate evidence. An untracked-file overlay is part of the candidate and must not be omitted.

## Run-scoped publication grant (AC-GRANT)

Before the first external update, obtain a single **run-scoped publication grant**. Ask once, and enumerate both lists.

It may authorize:

- new normal commits;
- **non-force push** to the current pull-request branch;
- required pull-request body updates;
- GitHub review-thread replies;
- configured external-site disposition comments or status transitions;
- validation and disposition summaries.

It **never authorizes** merge, force-push, amend, rebase, history rewrite, ADR acceptance, authoritative issue changes, failed-gate bypass, or a different repository, pull request, or branch. Each of those needs its own explicit owner approval.

The grant is bound to this repository, pull request, branch, and run, and **expires when the run ends**, is aborted, or changes target.

## Gate loop (AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

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

`sol-reviewer` owns contracts, scope, maintainability, and test coverage. `terra-reviewer` then owns concurrency, lifetime, ownership, cleanup, portability, deadlocks, races, and use-after-free risk. **Never start the Terra gate before the Sol gate returns `MERGE`.**

### Gate verdicts (CL-D1)

Every gate must end with a verdict line using exactly this vocabulary:

```text
MERGE | FIX BEFORE MERGE | NEEDS DECISION
```

Require that verdict line in the invocation payload rather than relying on the agent to supply one. **Do not modify any file under `agents/`**: the existing agents must stay unchanged and independently usable.

Only the parsed verdict decides whether a gate passed. **A missing or unparsable verdict is a tool-level failure**: retry the invocation once, and if it fails again report `BLOCKED`.

### Invocation payload (CL-D2)

Every agent in this package sets `inheritSkills: false`, so nothing in this skill reaches a subagent automatically. **Nothing may rely on a child inheriting this skill.** Each invocation must restate:

- the required verdict vocabulary and that the verdict must be the last line;
- whether the child is read-only or the sole writer;
- the target, the relevant fingerprints, and the exact diff under review;
- the applicable Language Profile entries;
- the finding format: severity, evidence, impact, and smallest correction;
- the scope boundary, so the child does not redesign approved decisions.

### Round accounting (CL-D11, CL-D12)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- A gate rerun caused by a fix consumes a round from that gate's budget.
- If a Terra finding forces a change to something Sol already approved, the Sol gate must run again and consumes one of its own rounds. The same applies to a fix that originates from an external finding.
- At the limit, stop and report `ROUND_LIMIT_REACHED` and ask the owner whether to grant more rounds.

Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block. **Do not create a state file** to work around this; persistent workflow state is a later stage.

## External review (CL-D18, CL-D17)

External gates apply only to pull-request readiness, and only through what is observable on the pull request with `gh`.

Detection is limited to reviews, comments, and checks present on the current `pr_head`. A service that has produced none of those is **not detected** and is reported as such, never as passed and never as failed. Distinguish not configured, configured but not started, pending, completed without findings, completed with findings, failed, stale for an older head, and authentication or rate-limit failure. Never treat an unknown state as success.

Observation policy, which this MVP reports against rather than enforces:

- before the first Sol invocation, take exactly one initial external-review snapshot of reviews, comments, and checks for the current `pr_head` using `gh`; this snapshot is the observation origin;
- a **two-minute quiet period** after the latest external event;
- a **fifteen-minute** maximum observation window per head, measured from that initial snapshot (a new head starts a new origin);
- a new head resets both.

The initial snapshot is not polling and does not delay internal review. This MVP has no timers and **must not busy-poll** or spend turns waiting. When required processing has not completed, report `WAITING_EXTERNAL_REVIEW` with a status block and let the operator resume; a timeout is neither success nor provider failure.

Treat CodeRabbit and SonarCloud as required once detected. Process GitHub Copilot review findings when observed, but never block merely because an optional Copilot review is absent. Human `Changes requested` and required approvals are a separate repository-policy gate.

### SonarCloud (CL-D17)

This MVP has no SonarCloud credentials or API integration, so it **cannot perform provider-side status transitions**. Disposition each Sonar finding, draft the Accepted rationale in the configured SonarCloud language, and, when publication is granted, post the summary to the pull request in the pull-request language. Performing the provider-side transition stays with the owner.

`MERGE_READY` **must not be declared on the basis of a transition that was never performed**. Report the remaining owner actions instead.

## Finding dispositions (AC-DISPOSITION)

Give every actionable finding **exactly one disposition**:

```text
fixed
accepted-as-designed
deferred
duplicate
not-applicable
needs-owner-decision
```

For each finding record the source and its stable identity, severity, the fingerprint it was raised against, evidence, impact, the disposition, the rationale, the corrective commit when fixed, validation evidence, and the reply or status URL when published.

Judge findings individually. A reviewer score, severity label, or provider recommendation is never by itself a decision to change code. Record the rationale for anything intentionally left unchanged; in review-only mode draft that reply without posting it, and when publication is granted give each unfixed GitHub finding its own reply.

Group the report into blockers, fixes worth making now, optional improvements, pre-existing findings, and findings intentionally declined.

## Owner decisions (AC-DECISION)

Pause for the owner on public contracts and APIs, architecture, scope, compatibility and risk trade-offs, policy exceptions, ADR acceptance, dangerous operations, and ship decisions.

Ask **one question at a time**, with options and a recommendation. Record durable decisions as:

```text
Decision ID
Kind
Target and revision
Question
Options and trade-offs
Recommendation
Owner choice
Rationale
Validity and invalidation conditions
```

Long-lived contract, waiver, and risk decisions belong on the pull request in the configured language, posted only after explicit approval. While a decision is pending the state is `WAITING_FOR_OWNER`.

## Test provenance (AC-TDD)

Classify the coverage backing each fix truthfully as one of:

```text
pre-implementation behavioral RED
pre-implementation compile/contract RED
co-developed integration coverage
review-driven regression
retrospective reproduction
```

Require a meaningful behavioral RED for deterministic bug fixes and behavior exercisable through an existing test seam. Permit truthful co-development for integration scaffolding, new module bootstrapping, platform-only packaging checks, and review-driven regression coverage when a pre-implementation behavioral RED is impractical.

**Never fabricate RED evidence**, and **never rewrite history to simulate** a test-first chronology. Merging without required deterministic coverage needs explicit owner approval.

## Outcome and status block (CL-D13, CL-D14)

Use these tokens exactly:

```text
MERGE_READY
WAITING_EXTERNAL_REVIEW
WAITING_FOR_OWNER
ROUND_LIMIT_REACHED
BLOCKED
ABORTED
```

Before declaring `MERGE_READY`, refresh external findings, required human-review state, and required checks against the current `pr_head`. A new finding, a failed check, `Changes requested`, or a new head revokes readiness. `MERGE_READY` means the pull request is ready for a human to merge; never merge it yourself.

Whenever the run stops, emit a resumable block:

````text
```tidd-status
target: <owner/repo#123>
mode: <review-only|autofix>
state: <token>
active_gate: <sol|terra|external|none>
fingerprints: issue_spec <d> base <d> tree <d> diff <d> commits <d> head <sha> candidate_diff <d|none>
rounds: sol <used>/3, terra <used>/3
dispositions: <counts by disposition>
pending_decisions: <decision ids or none>
publication_grant: <none|granted, expires with this run>
invalidated_evidence: <what must be redone>
next_action: <the single next permitted action>
```
````

To resume, the operator pastes that block back with the command. On resume, **revalidate the fingerprints** first and refuse to continue against a changed target; recompute instead of trusting the pasted state. A pasted grant is never honoured, because the grant expired with its run.

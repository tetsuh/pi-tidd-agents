# Closed-loop workflow contract

The authoritative record of the decisions the closed-loop skills implement.

These decisions were made during [#3](https://github.com/tetsuh/pi-tidd-agents/issues/3) and its implementation in [#6](https://github.com/tetsuh/pi-tidd-agents/pull/6). The [decision comment on #3](https://github.com/tetsuh/pi-tidd-agents/issues/3#issuecomment-5076813054) is the historical record and is superseded by this file, which moved here under CL-D26 because #3 closed.

`CL-D*` entries are decisions taken while implementing the workflow. `AC-*` entries are obligations that come from #3's acceptance criteria rather than from a decision; they are recorded here so every clause resolves to something. `DEC-*` entries are owner decisions taken during a run.

**How this file is enforced.** `test/contract-clauses.json` maps each obligation to literal text that must appear in a named file, and `test/contract-record.test.js` checks that every clause resolves to a decision here and that every decision here either owns a clause or is annotated `**Clauses:** none — structural`. Adding a clause without a decision, or leaving a decision with nothing enforcing it, fails the build. Three contract changes reached `main` without a record while that record lived in a GitHub comment; nothing could check a comment.

**What a clause can and cannot prove.** A clause proves that required text is present. It cannot prove a document says only one thing: three contradictions passed review because every required literal sat in the stale half of a superseded rule. Retired wordings are therefore named explicitly in the superseded-rule guard in `test/closed-loop-regressions.test.js`.

---

## CL-D1 — Gate verdicts are supplied by the caller, not by agent files
**Clauses:** CL-D1-issue, CL-D1-pr

`terra-oracle` has no verdict contract of its own, and the acceptance criteria require the existing agents to stay unchanged. The verdict line is therefore required through the invocation payload, and nothing under `agents/` is modified. A missing or unparsable verdict is a tool-level failure: retry once, then report `BLOCKED`.

## CL-D2 — Every constraint is restated in the invocation payload
**Clauses:** CL-D2

All agents set `inheritSkills: false`, so skill content never reaches a subagent. Each invocation restates the verdict format, authority, target and fingerprints, language profile, finding format, scope boundary, the acceptance criteria, and — on a re-invocation — the prior rounds' findings with their dispositions.

Without that last part the gate loop cannot terminate. Reviewers run with fresh context, so a disposition the parent recorded is invisible to the next round and any finding not literally fixed returns indefinitely, which leaves fixing everything as the only exit. Five Sol rounds on #6 demonstrated it: the gate returned `MERGE` at round 3, a Terra blocker reopened it, and later rounds kept finding gaps in text written to answer the rounds before them.

## CL-D3 — Writer selection
**Clauses:** CL-D3

The default autofix writer is `luna-worker`. A run has **exactly one writer**; if that writer fails to start, stop and **Do not fall back to another worker**. Selecting an alternate worker requires an explicit owner instruction in conversation.
 `terra-worker` is excluded because its model also grades the Terra gate, and a gate verdict here is an automated exit condition rather than advice to a human. `glm-worker`'s model does not grade a gate either, so the self-grading argument alone does not separate it; it is excluded because choosing it would require a second model family on top of the reviewers'.

The originally published rationale claimed `luna-worker` was the only worker whose model is not a gate grader. That was false, and the contract test had literal-matched the false wording, so the suite held the error in place.

## CL-D4 — Do not use `context.md` / `plan.md`
**Clauses:** CL-D4

The workers' `defaultReads` name those files, but creating them is a file mutation forbidden in review-only mode and they are not ignored by `.gitignore`. Everything is passed inline in the payload instead.

## CL-D5 — `pi-subagents` is a hard runtime dependency
**Clauses:** CL-D5

Subagents are invoked only through its documented interface. If it is unavailable the workflow stops with installation guidance and never falls back to editing directly.

## CL-D6 — Mode token parsing is exact and fails closed
**Clauses:** CL-D6-skill, CL-D6-prompt

The mode token is the final token of the raw argument vector, evaluated once the target reference has been recognised. Exactly `autofix` selects autofix; no remaining token means review-only; anything else stops with usage.

The original wording said "the argument immediately following the target reference", which held only while a reference was one token. `Issue #123` and `PR #123` are accepted forms, and positional binding split them so `#123` was read as the mode token and rejected — an explicitly accepted form did not work.

## CL-D7 — Target kind is verified, never assumed
**Clauses:** CL-D7

GitHub numbers issues and pull requests in one sequence, so the reference alone does not identify the kind. The target is resolved through `gh`, verified against the command, and never inferred from the current branch. The prompt passes the complete raw argument vector and the skill owns the grammar.

## CL-D8 — Targets outside the current repository
**Clauses:** CL-D8, CL-D8-foreign

A foreign target may be reviewed in review-only mode, with evidence from the GitHub API and no checkout. Autofix refuses such a target.

## CL-D9 — Evidence-specific fingerprints
**Clauses:** CL-D9, CL-D9-issue, CL-D9-pr

`issue_spec`, `pr_base`, `pr_tree`, `pr_diff`, `pr_commits` and `pr_head` are tracked separately so a change invalidates only what it affects. Digests are `sha256` over a defined byte serialisation, computed with a shell command and never estimated. API evidence collection is bracketed by fresh base/head reads, since independent calls are separate requests against a moving target.

An authoritative comment is one whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` and whose author is not a bot.

## CL-D10 — Worktree precondition for autofix
**Clauses:** CL-D10

Autofix requires the head branch already checked out and a clean tree. The workflow never switches branches, stashes, or discards: that is a git-state change nobody authorised and it can destroy uncommitted work.

## CL-D11 — Round accounting
**Clauses:** CL-D11

A round is one completed gate invocation returning a parsable verdict, and the passing round counts. Tool, provider, startup, stale-target and unparsable-verdict failures do not consume one. A later gate forcing a change to something an earlier gate approved reruns the earlier gate against its own budget.

## CL-D12 — Round budgets are run-scoped
**Clauses:** CL-D12

This MVP keeps no state between invocations, so re-running resets every counter and the limit can be bypassed by re-running. Accepted; implementations must not add a state file to work around it, and every status block reports rounds used.

## CL-D13 — Status block and resume
**Clauses:** CL-D13, CL-D13-issue, CL-D13-pr

A run that stops emits a `tidd-status` block carrying the target, fingerprints, state, active gate, rounds, internal findings with dispositions, pending decisions, and the next permitted action. Resuming means pasting it back; fingerprints are revalidated and recomputed rather than trusted.

## CL-D14 — Canonical status tokens
**Clauses:** CL-D14-issue, CL-D14-pr

`IMPLEMENTATION_READY`, `MERGE_READY`, `WAITING_EXTERNAL_REVIEW`, `WAITING_FOR_OWNER`, `ROUND_LIMIT_REACHED`, `BLOCKED`, `ABORTED`. `WAITING_FOR_OWNER` covers an owner action as well as an owner decision, rather than minting a token absent from #4's state list.

Readiness requires the approved artifact to be the published one. A run that drafted a revision, or left an unpublished candidate, ends at `WAITING_FOR_OWNER`: the gates approved something the target does not yet contain, and claiming readiness for content nobody else can see would be false.

## CL-D15 — Scratch-file boundary
**Clauses:** CL-D15

Review-only forbids modifying anything inside the repository working tree and any git, GitHub or external state. Working notes and drafts belong outside the repository.

## CL-D16 — Language Profile package defaults
**Clauses:** CL-D16

Conversation follows the operator's language; `github.issue` and `github.pull_request` default to English; external sites are unset and the workflow stops to ask before drafting content for one. The trigger is drafting rather than posting, because this MVP never posts and a trigger tied to the first post would never fire. The profile never governs source code, comments, documentation or commit messages.

## CL-D17 — SonarCloud disposition
**Clauses:** CL-D17

The MVP has no SonarCloud credentials, so it cannot perform provider-side status transitions. It dispositions each finding, drafts the rationale, and hands it over. Readiness is never declared on the basis of a transition that was never performed.

## CL-D18 — External observation is reported, not enforced
**Clauses:** CL-D18

The two-minute quiet period and fifteen-minute window are policy the MVP reports against. It has no timers and must not busy-poll. A service with no reviews, comments or checks on the current head is *not detected*, never passed and never failed; an unknown state is never treated as success.

## CL-D19 — Division of responsibility between prompts and skills
**Clauses:** none — structural

Prompt templates stay thin — frontmatter, argument capture, mode determination, and an instruction to load the skill — and the skill holds the workflow contract, so the two cannot drift apart.

Enforced by `test/package.test.js`, which asserts each prompt names the skill it loads and stays within a line budget.

## CL-D20 — Precondition guard
**Clauses:** CL-D20-issue, CL-D20-pr

Each skill runs only against an explicit target and otherwise stops with usage. Installing the package starts nothing.

## CL-D21 — Test seam, tooling and CI
**Clauses:** none — structural

Tests run under `node:test` with zero `devDependencies`, because pi runs `npm install` when installing a package and any devDependency would be installed for every user. A minimal GitHub Actions workflow runs them on push to `main` and on pull requests.

Enforced by `test/package.test.js`, which asserts the test script exists and that there are no `devDependencies`.

## CL-D22 — Closed-loop model requirements and preflight
**Clauses:** CL-D22-issue, CL-D22-pr

The closed loop composes this exact runtime set: `sol-reviewer` → `gpt-5.6-sol`, `terra-oracle` → `gpt-5.6-terra`, `terra-reviewer` → `gpt-5.6-terra`, and conditional `luna-worker` → `gpt-5.6-luna`. `glm-worker` is excluded from the closed loop and remains standalone because selecting it would add a second model family. Skills use runtime names, never model IDs, and preflight only the agents required by their command.

The closed loop composes a fixed agent set, unlike à la carte standalone use. Skills name agents by runtime name and never by model ID, so an operator without those models can supply their own definitions under the same names. Each skill preflights the agents its own command needs, and a missing agent stops the run rather than failing mid-gate.

## CL-D23 — Candidate evidence after autofix edits
**Clauses:** CL-D23

Post-fix gates receive the exact working-tree change including untracked files, since `pr_tree` and `pr_diff` do not move for uncommitted edits. `candidate_diff` is a `sha256` over that change set, and its job is change detection within a single run — not proof across machines or sessions, and never compared against a commit, because this MVP creates none.

## CL-D24 — External observation is per-run and never carried forward
**Clauses:** CL-D24

Before the first Sol invocation, take exactly one external-review snapshot for the current head; that snapshot is the observation origin. It is not polling and does not delay internal review. A later run takes its own snapshot and carries no external evidence or origin forward; the quiet-period and fifteen-minute policy are reported for the current run only.

External evidence is not carried across runs. A resumed or later run takes its own snapshot, reprocesses what it sees, and reports the window for that run's observation only. An undeterminable state is reported as unknown rather than complete. Findings the workflow raises itself do carry, since their identities are assigned here rather than by a provider.

## CL-D25 — Validated `pi-subagents` minimum, and what a normal commit is
**Clauses:** CL-D25, CL-D25-commit

The validated minimum is `0.36.0`, verified as the version installed in the validating environment. A normal commit follows Conventional Commits, carries the issue number, and states test provenance in its body when covered behaviour changes. The commit convention is not machine-checked.

## CL-D26 — The authoritative contract record lives in this file
**Clauses:** none — structural

`CL-D1` through `CL-D25` lived in one comment on #3, which closed when the implementation merged, and new obligations already had nowhere to go. Three contract changes had landed without a record by then.

The record is this file, kept out of `files` so it is a development record rather than package payload, with a test asserting that clauses and decisions stay in step. Keeping the record on an issue cannot be enforced by anything, and the gap was structural rather than an attention failure. The accepted trade-off is that a record inside the repository can be changed in the same commit as the thing it records; the consistency test is what compensates.

Enforced by `test/contract-record.test.js`, which is this decision.

## CL-D27 — Target stability during a run
**Clauses:** CL-D27

The target identity is re-resolved before every gate invocation and must be unchanged; anything else stops the run without mutation, and nothing is cleaned or switched to make the check pass.

The rule is short because this MVP performs no publication. An earlier version enumerated phases — before the commit, after the commit, before the push, after the push — and review found the enumeration covered commit and push while leaving body updates, replies, dispositions and summaries unguarded. Enumeration invites omission; adding the missing phase only moves it.

## CL-D28 — The MVP does not publish
**Clauses:** CL-D28

The workflow never commits, pushes, updates a body, replies to a thread, or changes an external service, and must not ask for that authority. A run reports what it found and what it changed in the working tree, with commit messages and replies drafted. The operator publishes.

Three consecutive reviews each returned four valid findings of one shape: a comparison or digest specified without a byte-exact serialisation, whose fix introduced the next one. Closing the class meant writing Git's tree-hashing algorithm and a canonical serialisation of GitHub's event streams in Markdown, for a model to execute at runtime. The decisive objection is not the size of that work but that the clause suite can only verify that prose is present, never that a model executes it — so a more elaborate specification buys review approval without buying correctness.

The capability was removed rather than the specification refined. The byte-exact machinery belongs to #4 and #5, where it is code: a tree hash is a library call, fixtures are real files, and tests exercise behaviour instead of asserting that a paragraph exists.

Enforced by `AC-GRANT` and by the superseded-rule guard in `test/closed-loop-regressions.test.js`, which names the retired publication wordings.

## DEC-EXT-SNAPSHOT-001 — External observation resumes by re-fetching
**Clauses:** none — structural

*Kind:* contract. *Target:* #6.

CL-D24 required a digest of the observed external events so a resume could detect edits, while CL-D28 had removed exactly that kind of specification. The digest had been justified as cheap, "under the CL-D9 serialisation rules", but CL-D9 defines a record shape for issue comments only; reviews, review comments and check runs are different shapes.

The first choice kept the origin and compared findings by stable identity. Review then asked what that identity is, and the answer needed provider-native identifiers, edit timestamps and head association per source, with fixtures — Issue #5's stated content. So external evidence is not carried at all. The origin is not carried either, and each run reports its own observation honestly.

*Validity:* holds while the MVP reports the observation window rather than enforcing it. If #4 enforces timing or needs to distinguish an edit from a re-fetch, revisit it with code.

Its outcome is enforced by `CL-D24`.

---

## AC-AUTOFIX — Autofix is file-mutation permission only
**Clauses:** AC-AUTOFIX

It does not by itself authorise commits, pushes, comments, external changes, history rewriting or merge, and only the smallest correction inside the approved contract is applied.

## AC-DECISION — Owner decision record
**Clauses:** AC-DECISION

Nine fields: Decision ID, Kind, Target and revision, Question, Options and trade-offs, Recommendation, Owner choice, Rationale, Validity and invalidation conditions. Questions are asked one at a time.

## AC-DISPOSITION — Finding disposition ledger
**Clauses:** AC-DISPOSITION, AC-DISPOSITION-issue, AC-DISPOSITION-pr

Every actionable finding gets exactly one of `fixed`, `accepted-as-designed`, `deferred`, `duplicate`, `not-applicable`, `needs-owner-decision`, with the full record for each. The enumerations are pinned whole and scoped to their section: field names matched individually were satisfied by unrelated prose elsewhere in the file, so a record could lose a column silently.

## AC-GATES — Sequential Sol then Terra
**Clauses:** AC-GATES

The Terra gate never starts before the Sol gate returns `MERGE`.

## AC-GRANT — Run-scoped publication grant
**Clauses:** AC-GRANT

Documented as the contract for the stage that will perform publication, so it is not redesigned from scratch. It never authorises merge, force-push, amend, rebase, history rewrite, ADR acceptance, authoritative issue changes, failed-gate bypass, or a different target, and it expires when its run ends. This MVP does not exercise it (CL-D28).

## AC-ISSUE-NO-EXTERNAL — Issue readiness excludes external gates
**Clauses:** AC-ISSUE-NO-EXTERNAL

External review services, static-analysis sites and pull-request checks are not part of issue readiness.

## AC-REVIEW-ONLY — Review-only is the default
**Clauses:** AC-REVIEW-ONLY-skill, AC-REVIEW-ONLY-prompt

Without the exact `autofix` token: no file edits, no git-state changes, no commits or pushes, no posting to GitHub, no replies to review threads, no external mutation.

## AC-TDD — Risk-based test-first policy and truthful provenance
**Clauses:** AC-TDD

Coverage is classified as pre-implementation behavioural RED, pre-implementation compile/contract RED, co-developed integration coverage, review-driven regression, or retrospective reproduction. RED evidence is never fabricated and history is never rewritten to simulate chronology.

The two pre-implementation classes are separated by what a test does, not by where its inputs come from: inspecting an artifact's content or structure is compile/contract; executing the thing being specified and observing what it does is behavioural, wherever that thing lives. Assertion polarity is irrelevant. This is written down because the call was got wrong four times, and because the first attempt at the rule was itself too broad — it separated the classes by input origin, which would misclassify a unit test importing a module from this repository.

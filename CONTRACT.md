# Closed-loop workflow contract

The authoritative record of the decisions the closed-loop skills implement.

These decisions were made during [#3](https://github.com/tetsuh/pi-tidd-agents/issues/3) and its implementation in [#6](https://github.com/tetsuh/pi-tidd-agents/pull/6). The [decision comment on #3](https://github.com/tetsuh/pi-tidd-agents/issues/3#issuecomment-5076813054) is the historical record and is superseded by this file, which moved here under CL-D26 because #3 closed.

`CL-D*` entries are decisions taken while implementing the workflow. `AC-*` entries are obligations that come from #3's acceptance criteria rather than from a decision; they are recorded here so every clause resolves to something. `DEC-*` entries are owner decisions taken during a run.

**How this file is enforced.** `test/contract-clauses.json` maps each obligation to literal text that must appear in a named file, and `test/contract-record.test.js` checks that every clause resolves to a decision here and that every decision here either owns a clause or is annotated `**Clauses:** none — structural`. Adding a clause without a decision, or leaving a decision with nothing enforcing it, fails the build. Three contract changes reached `main` without a record while that record lived in a GitHub comment; nothing could check a comment.

**What a clause can and cannot prove.** A clause proves that required text is present. It cannot prove a document says only one thing: three contradictions passed review because every required literal sat in the stale half of a superseded rule. Retired wordings are therefore named explicitly in the superseded-rule guard in `test/closed-loop-regressions.test.js`.

---

## CL-D1 — Gate verdicts are supplied by the caller, not by agent files
**Clauses:** CL-D1-issue, CL-D1-pr, CL-D1-issue-routing, CL-D1-issue-retry

`terra-oracle` has no verdict contract of its own, and the acceptance criteria require the existing agents to stay unchanged. The verdict line is therefore required through the invocation payload, and nothing under `agents/` is modified. A missing or unparsable verdict is a tool-level failure: retry once, then report `BLOCKED`.

## CL-D2 — Every constraint is restated in the invocation payload
**Clauses:** CL-D2, CL-D2-issue-role, CL-D2-pr-role

All agents set `inheritSkills: false`, so skill content never reaches a subagent. The shared `gate-contract.md` defines one named `### Run-invariant payload blocks (CL-D2, CL-D29)` with nested every-gate and Sol-only blocks for each effective workflow authority graph. The Issue and PR roots each define their Sol and Terra role-authority blocks once. The parent includes each applicable shared block and exactly one owning-root role block verbatim in every applicable gate invocation; defining them once does not reduce the transmitted size of any invariant block. A Luna correction instead receives the exact writer authority owned by the autofix mode. Each invocation also supplies its volatile envelope: target and fingerprints, exact body or diff, Language Profile, mode or gate correlation, and acceptance criteria.

The parent keeps a complete canonical finding ledger. Gate history is only a compact projection: full finding records only for unresolved findings and settled findings reopened by materially new evidence; settled summaries retain stable finding ID, source gate, raised-against identity, disposition, and confirmation gate or evidence, plus counts grouped by settled disposition. Exact autofix retains its mode-specific `blockerKey`. A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is settled and requires materially new evidence to reopen, not a restatement. Reopening must name materially new evidence and why the prior disposition no longer applies. The payload says re-raising one requires materially new evidence; a settled finding cannot be re-raised by restatement. A finding that names no acceptance criterion, contract clause, or fail-stop invariant is an out-of-scope improvement rather than a blocker (CL-D34). This preserves termination without weakening the complete parent ledger or workflow-specific record fields.

## CL-D3 — Writer selection
**Clauses:** CL-D3

For exact PR `autofix`, `luna-worker` is the mandatory and sole correction writer/publisher. A run has **exactly one writer**; if Luna fails to start, stop and **Do not fall back to another worker**. An owner request for any other worker is a CL-D30 contract change: stop before mutation, end the exact-autofix run, and do not resume it. Alternate-worker wording applies only to standalone explicit worker delegation outside the `/tidd-pr ... autofix` workflow; that delegation receives no CL-D30 authority and does not make the exact-autofix writer replaceable.
 `terra-worker` is excluded because its model also grades the Terra gate, and a gate verdict here is an automated exit condition rather than advice to a human. `glm-worker`'s model does not grade a gate either, so the self-grading argument alone does not separate it; it is excluded because choosing it would require a second model family on top of the reviewers'.

The originally published rationale claimed `luna-worker` was the only worker whose model is not a gate grader. That was false, and the contract test had literal-matched the false wording, so the suite held the error in place.

## CL-D4 — Do not use `context.md` / `plan.md`
**Clauses:** CL-D4

The workers' `defaultReads` name those files, but creating them is a file mutation forbidden in review-only mode and they are not ignored by `.gitignore`. Everything is passed inline in the payload instead.

## CL-D5 — `pi-subagents` is a hard runtime dependency
**Clauses:** CL-D5

Subagents are invoked only through its documented interface. If it is unavailable the workflow stops with installation guidance and never falls back to editing directly.

## CL-D6 — Mode token parsing is exact and fails closed
**Clauses:** CL-D6-skill

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
**Clauses:** CL-D10, CL-D10-pi-contract

Exact PR `autofix` first verifies `OPERATOR_CHECKOUT@H`: target/path, local `HEAD` and PR branch ref at public `H`, clean tracked/index state, no unexpected non-ignored untracked paths, and an opaque sorted ignored inventory explicitly enumerated as NUL-delimited normalized checkout-relative lexical paths plus no-follow kind. Absolute, empty, dot/dot-dot, unreadable, replaced, renamed, ambiguous, or unstable re-enumeration fails closed. Porcelain alone is insufficient; contents, targets, sizes, timestamps, and hashes are never read. safe no-follow classification of every enumerated `RUNTIME_ROOTS` member is required; each root is absent or a real directory, excluded from opaque inventory, and governed by existing independent rules. Staged deletion never cures a forbidden parent path; future additions require a recorded contract decision naming the producing tool, default configuration, and affected version range.

It then creates and verifies external `AUTOFIX_WORKSPACE@H`. Primary is a detached linked worktree (`git worktree add --detach`); a temporary clone is fallback only after unavailable creation and stable proof of no path, registration, or metadata side effect. Partial/ambiguous creation or verification is terminal. Bind repository/source/origin/fetch/push/branch, exact H/tree, detached HEAD, canonical path, common/per-worktree Git directories, and no copied operator paths. Every Git command, including creation, uses exact cwd plus a sanitized noninteractive environment, explicit config isolation, empty run-owned hooksPath, and no inherited helper/filter/fsmonitor/signing/pager/editor execution. Only shared objects, exact run-owned registration, and per-worktree administration are allowed in linked mode; neither mode mutates operator/shared config, branch refs, or index, and remote reads update no tracking ref. Normal push may move only verified remote-tracking `O -> C`. All gates, correction, validation, manifest, commit, push, and post-push actions use workspace cwd. Push is exactly normal non-force `HEAD:refs/heads/<verified-pr-branch>`.

`OPERATOR_CHECKOUT_UNCHANGED@O` compares the immutable operator baseline at mandatory discrete boundaries, not continuously. Validation-created ignored caches are frozen run-owned sandbox state permitted only outside correction/evidence/manifest/commit/publication; drift or staging blocks. `REPLY_EXCEPTION` remains the sole provider-mutation exception. Review-only and Issue workflows remain unchanged.

## CL-D11 — Round accounting
**Clauses:** CL-D11, CL-D11-review-only

A round is one completed gate invocation returning a parsable verdict. There are a maximum of three completed invocations per gate, per target, per run, and the passing round counts. A gate rerun caused by a fix consumes a round from that gate's budget; a later gate forcing a change to something an earlier gate approved reruns the earlier gate against its own budget. Tool, provider, startup, stale-target and unparsable-verdict failures do not consume one. On exhaustion, report `ROUND_LIMIT_REACHED` and request an owner decision before continuing.

## CL-D12 — Round budgets are run-scoped
**Clauses:** CL-D12

This MVP keeps no state between invocations, so re-running resets every counter and the limit can be bypassed by re-running. Accepted; implementations must not add a state file to work around it, and every status block reports rounds used.

## CL-D13 — Status block and resume
**Clauses:** CL-D13, CL-D13-issue, CL-D13-pr

Outside the CL-D31 candidate-publication phase, a legacy review run that stops emits a `tidd-status` block carrying the target, fingerprints, state, active gate, rounds, internal findings with dispositions, pending decisions, and the next permitted action. Resuming means pasting it back; fingerprints are revalidated and recomputed rather than trusted. During candidate construction and afterward in that phase, CL-D31 supersedes this status/resume rule: no resumable block is emitted or accepted.

## CL-D14 — Canonical status tokens
**Clauses:** CL-D14-issue, CL-D14-pr

`IMPLEMENTATION_READY`, `MERGE_READY`, `WAITING_EXTERNAL_REVIEW`, `WAITING_FOR_OWNER`, `ROUND_LIMIT_REACHED`, `BLOCKED`, `ABORTED`. `WAITING_FOR_OWNER` covers an owner action as well as an owner decision, rather than minting a token absent from #4's state list.

Readiness requires the approved artifact to be the published one. A run that drafted a revision, or left an unpublished candidate, ends at `WAITING_FOR_OWNER`: the gates approved something the target does not yet contain, and claiming readiness for content nobody else can see would be false.

## CL-D15 — Scratch-file boundary
**Clauses:** CL-D15

Review-only forbids modifying anything inside the repository working tree and any git, GitHub or external state. Working notes and drafts belong outside the repository.

## CL-D16 — Language Profile package defaults
**Clauses:** CL-D16

Conversation follows the operator's language; `github.issue` and `github.pull_request` default to English; external sites are unset and the workflow stops to ask before drafting content for one. Before candidate construction and outside the CL-D31 phase, Issue workflow and PR review-only never post. During CL-D31 only, the exact approved GitHub Issue body PATCH and ledger POST are allowed; external sites, provider-side review-service mutation, and every other provider API mutation remain forbidden. Exact PR `autofix` may post only `REPLY_EXCEPTION`, and no Issue authority originates from PR mode. The trigger remains drafting rather than posting: when an external destination has no configured language, the workflow stops before drafting rather than guessing, so no posting capability is required to enforce the language boundary. The profile never governs source code, comments, documentation or commit messages.

## CL-D17 — SonarCloud disposition
**Clauses:** CL-D17

The MVP has no SonarCloud credentials, so it cannot perform provider-side status transitions. It dispositions each finding, drafts the rationale, and hands it over. Readiness is never declared on the basis of a transition that was never performed.

## CL-D18 — External observation is reported, not enforced
**Clauses:** CL-D18

The two-minute quiet period and fifteen-minute window are policy the MVP reports against. It has no timers and must not busy-poll. A service with no reviews, comments or checks on the current head is *not detected*, never passed and never failed; an unknown state is never treated as success.

## CL-D19 — Division of responsibility between prompts, Skills, and mode references
**Clauses:** none — structural

Prompt templates contain only frontmatter, complete raw argument capture, the loaded Skill name, and an instruction to follow that Skill as authoritative. They must not restate workflow clauses, including target grammar, mode parsing, safety prohibitions, publication boundaries, or gate transactions; those obligations have one source of truth in the Skill authority graph. Each workflow prompt loads its workflow Skill, and each workflow root reads both non-skill shared references `../closed-loop-shared/references/gate-contract.md` and `../closed-loop-shared/references/records.md`. The shared `gate-contract.md` owns common target-reference grammar. It also owns the named run-invariant payload blocks loaded by each effective workflow authority graph. Each formal gate receives the every-gate block; each Sol route also receives the Sol-only block; each invocation receives one concrete role-authority block from its workflow or mode owner. The PR `SKILL.md` owns CL-D6 mode parsing, target-kind resolution/handling, evidence identity, shared dispatch, and mode selection. After CL-D6 parsing succeeds, a PR run reads exactly one authoritative mode continuation: `references/review-only.md` or `references/autofix.md`; it never reads both. Everything downstream that applies only to the parsed mode belongs to that mode reference. The shared references own only genuinely common grammar, gate/evidence, record, and truthful AC-TDD policy; Issue-specific and PR/mode-specific behavior remains in its owning file.

Authority graph: `prompt -> workflow SKILL.md -> both shared references -> exactly one PR mode reference when applicable`.

Enforced by `test/package.test.js`, which asserts each prompt names its Skill, passes raw `$@` exactly once, declares the Skill authoritative, contains no workflow restatement, and shares no normalized 60+ character sentence with its root Skill; both workflow roots name each shared reference exactly once, no shared `SKILL.md` creates a third Skill, and the PR Skill dispatches to exactly one packaged mode reference.

## DEC-I22-PROMPT-AUTHORITY-001 — CL-D19 prompt authority
**Clauses:** none — structural
*Decision ID:* DEC-I22-PROMPT-AUTHORITY-001
*Kind:* owner decision
*Target and revision:* `tetsuh/pi-tidd-agents#22` at the 2026-08-10 JST implementation decision
*Question:* Should prompt templates restate workflow clauses or defer all workflow authority to the loaded Skills?
*Options and trade-offs:* Option A makes prompts thin dispatchers and keeps each workflow rule in one Skill authority; Option B permits selected safety-critical restatements but creates synchronization obligations; Option C permits only a narrow review-only exception while retaining multiple sources of truth.
*Recommendation:* Adopt Option A and make CL-D19 the sole authority boundary.
*Owner choice:* Option A approved by the owner response `OK. A で進めて`.
*Rationale:* Thin prompts eliminate drift and per-invocation payload cost without removing any Skill-owned safety obligation; the Skill is loaded before workflow execution and remains authoritative.
*Validity and invalidation conditions:* Valid for the current prompt-to-Skill authority graph and Issue #22 scope. A future invocation path that does not load the Skill must fail closed rather than restore duplicated workflow prose; any exception requires a later explicit owner decision.

## DEC-I23-PAYLOAD-COMPACTION-001 — Option A payload history compaction
**Clauses:** none — structural
*Decision ID:* DEC-I23-PAYLOAD-COMPACTION-001
*Kind:* owner decision
*Target and revision:* `tetsuh/pi-tidd-agents#23`, owner comment [#issuecomment-5243505239](https://github.com/tetsuh/pi-tidd-agents/issues/23#issuecomment-5243505239), created `2026-08-10T17:11:21Z` (`2026-08-11 JST`)
*Question:* How should per-invocation payload restatement cost be reduced without changing `agents/**` or weakening the CL-D2 termination property?
*Options and trade-offs:* Option A keeps `agents/**` byte-identical, defines the invariant payload block once in the shared gate contract, and compacts only settled finding history; Option B changes `agents/sol-reviewer.md` and risks operator overrides lacking the closed-loop procedure; Option C measures first and defers the contract change. Option A saves source duplication and accumulated history transport while retaining fixed invariant transmission; Option B offers larger theoretical savings but violates the standing frozen-agent boundary; Option C provides data but leaves the accepted contract unresolved.
*Recommendation:* Adopt Option A.
*Owner choice:* The operator response was `A で進めて。この内容を Issue に投稿もして`; the authorized English owner comment records `Proceed with Option A.` and its accompanying constraints. These are distinct records; identical bytes are not claimed.
*Rationale:* The shared authority graph remains the single source for common gate policy. The parent reuses each applicable invariant block verbatim in every applicable invocation, while compact settled summaries preserve finding identity, raised-against identity, disposition, confirmation evidence, and the materially-new-evidence rule. `terra-oracle` continues receiving the payload-supplied verdict contract, and every Sol invocation continues receiving the complete CL-D29 procedure. Defining the invariant blocks once does not reduce the transmitted size of any invariant block. The bounded retrospective record `test/records/issue-23-payload-measurement.json` uses recorded real Sol run `9b057bb3` and final transmitted read-only replay `cfd6cad8`; for the same settled finding it measures the controlled history projection at 1,069→556 UTF-8 bytes and 293→195 `tiktoken 0.11.0` `o200k_base` tokens. It explicitly makes no whole-task causal, provider-token, or runtime-compliance claim.
*Validity and invalidation conditions:* Valid for Issue #23 and the current prompt → workflow Skill → shared-reference authority graph. `agents/**` must remain byte-identical for this scope. No token-reduction claim is valid without a controlled recorded before/after measurement from a real run; static tests are compile/contract coverage only and do not prove runtime payload construction or model compliance. Any change to agent files, omission of required invariant or CL-D29/verdict content, or history projection that cannot distinguish restatement from materially new evidence requires a later owner decision.

## CL-D20 — Precondition guard
**Clauses:** CL-D20-issue, CL-D20-pr

Each skill runs only against an explicit target and otherwise stops with usage. Installing the package starts nothing.

## CL-D21 — Test seam, tooling and CI
**Clauses:** none — structural

Tests run under `node:test` with zero `devDependencies`, because pi runs `npm install` when installing a package and any devDependency would be installed for every user. A minimal GitHub Actions workflow runs them on push to `main` and on pull requests.

Enforced by `test/package.test.js`, which asserts the test script exists and that there are no `devDependencies`.

## CL-D22 — Closed-loop model requirements and preflight
**Clauses:** CL-D22-issue, CL-D22-pr, CL-D22-issue-agents, CL-D22-pr-agents

The closed loop composes this exact runtime set: `sol-reviewer` → `gpt-5.6-sol`, `terra-oracle` → `gpt-5.6-terra`, `terra-reviewer` → `gpt-5.6-terra`, and conditional `luna-worker` → `gpt-5.6-luna`. `glm-worker` is excluded from the closed loop and remains standalone because selecting it would add a second model family. Skills use runtime names, never model IDs, and preflight only the agents required by their command.

The closed loop composes a fixed agent set, unlike à la carte standalone use. Skills name agents by runtime name and never by model ID, so an operator without those models can supply their own definitions under the same names. Each skill preflights the agents its own command needs, and a missing agent stops the run rather than failing mid-gate.

## CL-D23 — Candidate evidence boundary by mode
**Clauses:** CL-D23

Review-only never edits the repository and has no formal post-fix working-tree candidate; proposed patches and drafts stay outside the repository. Exact PR `autofix` uses only the published public-head OID after Luna's normal commit and verified non-force push. `candidate_diff` is not an exact-autofix identity and is not used to authorize a gate, resume, or publication.

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

The rule was short while the review-only MVP performed no publication. CL-D30 exact PR `autofix` now supplies explicit edit, commit, push, reply, final-classification, and summary-approval phases; every phase is bound by complete target identity and stale-target safety.

## CL-D28 — Mode-scoped publication boundary (historical no-publication rule)
**Clauses:** CL-D28

Before CL-D31, Issue workflow and PR review-only were no-publication modes, and exact PR `autofix` was the sole scoped exception. Current rule: PR review-only still never commits, pushes, posts, replies, or changes external state; exact PR `autofix` retains only CL-D30's bounded correction and `REPLY_EXCEPTION`. Issue workflow remains no-publication before candidate construction and outside the CL-D31 candidate-publication phase. During CL-D31 only, exact same-session approval authorizes at most one optional current-repository Issue body PATCH followed by one exact ledger POST. All other publication, merge, force-push, history rewrite, provider mutation, approval, thread-resolution, authoritative Issue change, aggregate-summary action, Git mutation, and repository-file mutation remain prohibited.

Three consecutive reviews each returned four valid findings of one shape: a comparison or digest specified without a byte-exact serialisation, whose fix introduced the next one. Closing the class meant writing Git's tree-hashing algorithm and a canonical serialisation of GitHub's event streams in Markdown, for a model to execute at runtime. The decisive objection is not the size of that work but that the clause suite can only verify that prose is present, never that a model executes it — so a more elaborate specification buys review approval without buying correctness.

Historical rationale: the original review-only MVP capability was removed rather than the specification refined. The byte-exact machinery was expected to belong to #4 and #5, where code could enforce it. CL-D30 later reopened only exact PR `autofix`; CL-D31 later and separately adopted the owner-approved legacy Issue Skill/prompt exception while explicitly retaining the limitation that prose and fixtures cannot prove orchestration behavior.

The current mode-scoped boundary is enforced by `AC-GRANT`, CL-D30, CL-D31, and the scoped/negative contract assertions in `test/closed-loop-regressions.test.js`.

## CL-D29 — Sol attempts adversarial falsification of absolute claims
**Clauses:** AC-ADVERSARIAL, AC-ADVERSARIAL-payload-issue, AC-ADVERSARIAL-payload-pr

Sol treats the exact issue or pull-request body, the current authoritative decision record and qualifying comments supplied in its payload, and applicable Skill assertions as claims to verify rather than assumed context. It semantically enumerates universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, and `exactly`; keyword presence alone is not enumeration. It attempts falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence. When a named authoritative record is absent, that absence is not itself a finding; report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable.

A finding requires an actual cited counterexample disproving the claim, or a verdict-material claim that cannot be verified because required evidence is unavailable. Sol never invents a counterexample: no counterexample is neither a finding nor proof. Authoritative comments are restricted consistently with CL-D9 to non-bot authors with `author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`; superseded comments from #3 are not revived.

Both Skills bind the full procedure to every initial and re-invocation Sol payload because `inheritSkills: false`. The separate agent's primary benefit is model-family diversity; it may also add independent context, system-prompt, and failure boundaries. This is an existing Sol gate only: CL-D29 adds no gate, agent, mode, verdict, status token, round budget, prompt, package, or agent-file change. CL-D34 bounds the severity and disposition of the findings this procedure produces without narrowing the search.

## CL-D30 — Exact PR autofix publishes one bounded correction per public head
**Clauses:** CL-D30-loop, CL-D30-publication, CL-D30-circuit, CL-D30-replies, CL-D30-clean-boundaries, CL-D30-readme-mode, CL-D30-mode-safety, CL-D30-language-boundary, CL-D30-precondition, CL-D30-readiness, CL-D30-gate-correlation, CL-D30-preconditions, CL-D30-luna-authorization, CL-D30-manifest, CL-D30-source-schema, CL-D30-snapshot-routing, CL-D30-reply-safety, CL-D30-summary-safety, CL-D30-breaker-boundaries, CL-D30-pi-contract, CL-D30-pi-boundaries, CL-D30-pi-publication, CL-D30-pi-replies, CL-D30-pi-readme, CL-D30-pi-fixtures, CL-D30-pi-packaging, CL-D30-isolated-workspace

*Decision ID:* CL-D30
*Kind:* contract
*Target and revision:* exact `/tidd-pr <pr-ref> autofix` on the published Issue #10 contract
*Question:* How may exact PR autofix correct and publish a reviewed public head while preserving review-only and Issue behavior?
*Options and trade-offs:* Keep the CL-D28 no-publication MVP; add unrestricted publication; or authorize one bounded Luna normal commit/non-force push loop with immutable identity and fail-stop guards. Keeping no publication cannot implement the approved public-head loop; unrestricted publication violates the safety boundary; the bounded loop permits only the settled correction and reply actions.
*Recommendation:* Adopt the bounded public-head loop specified by Issue #10.
*Owner choice:* Adopt exact PR `autofix` only; Sol first, Terra second, mandatory `luna-worker` as the sole correction writer/publisher for correction/validation/one normal commit/one non-force push, restart at Sol after every push, and parent-only `REPLY_EXCEPTION`. A request for another worker stops before mutation and ends the exact-autofix run with no resume.
*Rationale:* The exact public head OID is the candidate identity. Complete target guards, operational-cleanliness and staged-manifest checks, immutable run-local blocker/confirmation records, 15/5/third-observation circuit breakers, and fail-stop behavior constrain publication without adding an extension, runtime state machine, durable workflow state, retry, resume, outbox, scheduler, or provider adapter. Review-only and Issue behavior remain unchanged, and aggregate summaries remain owner-approved actions outside the run. Issue #47 adds package-owned, node-invoked CommonJS helpers under the PR Skill, with no `main`, `bin`, extension, writer, or provider authority. Their local JSON v1 protocol implements observation, canonicalization, conservative complete-policy evaluation, and isolated-workspace lifecycle; it is not Issue #36's envelope and does not change Issue #45 exclusions. Clone artifacts are retained, helper failure is terminal, and discrete no-follow observations do not claim continuous hostile-race immunity.
*Validity and invalidation conditions:* Applies only to exact PR `autofix`, the current repository/PR/base/head identity, and the published Issue #10 scope. Any identity movement, ambiguity, failed guard, malformed verdict/record, validation or publication failure, owner decision, interruption, or limit ends the run; a later command is a fresh run, never resume. CL-D28/AC-AUTOFIX/AC-GRANT are superseded only for this bounded commit, non-force push, and `REPLY_EXCEPTION`. CL-D11, CL-D1, CL-D13, CL-D17/18/24, and publication-dependent CL-D23/27 prose are superseded only as explicitly scoped in the Skill.

**Issue #17 operational-cleanliness amendment, Issue #20 named-invariant refactor, and Issue #42 isolation:**
- `OPERATOR_CHECKOUT@H` := captured operator state at initial public `H`, which becomes immutable baseline `O`.
- `AUTOFIX_WORKSPACE@H` := exact external isolated workspace state at current public `H`.
- `WORKSPACE_POST_COMMIT(C, P)` := sole-parent workspace `C`, current public `P`, and exact manifest/tree/blob/state identity.
- `WORKSPACE_POST_PUSH(C, O)` := public/workspace `C` with no-replace sole-parent `O -> C` and clean state; linked permits only verified remote-tracking `O -> C`, clone operator stays `O`. Only linked after public/workspace verification may `operator_revalidate` receive `postPushHead: C`.
- `OPERATOR_CHECKOUT_UNCHANGED@O` := equality to every observation in immutable operator baseline `O`.
- `REPLY_EXCEPTION` := the sole provider exception.
`RUNTIME_ROOTS := { ".pi", ".pi-subagents" }` stays independently no-follow classified and outside opaque inventory; every root is absent or a real directory, and every root is classified independently without following links. Unexpected non-ignored untracked paths block. Runtime-root entries in candidate/public `HEAD` or index fail closed. The unfiltered raw effective diff remains authoritative. Runtime bytes are never claimed cleaned, preserved, validated, committed, or published. AFTER_COMMIT/BEFORE_PUSH independently require the post-commit invariant and reclassify every root; post-push gates require the post-push invariant. Every terminal success/failure rechecks the operator; only successful push reports behind. Optional cleanup after any success/failure terminal observation is exact identity-reverified non-force `git worktree remove` for a linked workspace only; cleanup failure stops, and recovery, compensation, force, prune, recursive deletion, clean, clone deletion, and operator mutation are forbidden. Review-only and Issue remain unchanged.

## CL-D31 — Owner-gated Issue candidate publication
**Clauses:** CL-D31-architecture-contract, CL-D31-architecture-skill, CL-D31-authority-contract, CL-D31-authority-skill, CL-D31-candidate-skill, CL-D31-resolver-skill, CL-D31-snapshot-skill, CL-D31-correlation-skill, CL-D31-preview-skill, CL-D31-publication-skill, CL-D31-readiness-skill, CL-D31-status-skill, CL-D31-language-skill, CL-D31-pr-boundary-pr, CL-D31-readme, CL-D31-fixtures, CL-D31-packaging
*Decision ID:* CL-D31
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#13` at the proposed revision based on published base `issue_spec` `7f527af828599860c4dcf2651c0bd329bca09e67c0c565dcf7e1616a2d5af0b7`
*Question:* How may the legacy Issue Skill/prompt workflow add owner-gated candidate publication while preserving review-only, PR, and all unlisted mutation boundaries?
*Options and trade-offs:* Keep the Issue workflow review-and-draft-only and require a later manual publication; add unrestricted Issue publication; or authorize one immutable, fully reviewed candidate with one exact same-session preview and one bounded no-retry attempt. Manual publication preserves the old boundary but spends duplicate gates; unrestricted publication violates safety; the bounded exception removes duplicate posting while retaining fail-closed identity, snapshot, and approval guards.
*Recommendation:* Adopt the bounded Issue-only candidate-publication workflow specified by published Issue #13.
*Owner choice:* Adopt CL-D31 only for `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>` as equivalent entrypoints: Sol first, Terra second, one frozen complete `tidd-issue-candidate-v1` bundle, one exact same-session owner preview, at most one optional body PATCH followed by one exact ledger POST to the current repository, no retry/resume/compensation, and observational snapshot-C proof. Preserve all PR/CL-D30, foreign-repository, provider, Git, file, and unlisted mutation prohibitions.
*Rationale:* The legacy Skill/prompt package can prepare and review a complete candidate without introducing executable runtime code; it has no executable controller or extension. Immutable bytes, independent resolver checks, complete stable captures, exact gate correlation, and same-session approval constrain the narrow publication exception while preserving the old no-mutation behavior before candidate construction and outside the candidate phase.
*Validity and invalidation conditions:* Applies only to the two named Issue entrypoints and this bounded Issue #13 exception. It remains valid until a later explicit owner-approved contract decision separates the entrypoints or changes the shared Skill architecture. It grants no authority to PR commands, other aliases, foreign repositories, provider review services, Git state, repository files, or any unlisted action.

The exception supersedes CL-D13, CL-D13-issue, CL-D16, CL-D28, AC-AUTOFIX, AC-GRANT, and AC-REVIEW-ONLY only for these two Issue entrypoints and only for the bounded actions and candidate-phase rules above. PR review-only, exact PR `autofix`, CL-D30, foreign-repository review-and-draft-only behavior, and all unlisted prohibitions remain unchanged.

## CL-D32 — Scope-freeze approval stays inside the candidate transaction
**Clauses:** CL-D32-architecture-contract, CL-D32-transaction-contract, CL-D32-eligibility-contract, CL-D32-round-contract, CL-D32-decision-contract, CL-D32-safety-contract, CL-D32-fixtures, CL-D32-packaging, CL-D32-skill, CL-D32-readme

*Decision ID:* CL-D32
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#15` at published Issue #15 body SHA-256 `7d04df705a9e503464178148d70ad2755da720441ce61d0a8eaffee4d35c0b23`, final published `issue_spec` `b850ae9fe339a3881f739ee8a7295e700047319e7f781dff16cc7d032d98734c`, and the target-specific base revision used by its candidate
*Question:* How can one readiness-relevant pre-candidate scope-freeze response enter the existing CL-D31 candidate transaction without standalone publication or gate bypass?
*Options and trade-offs:* Retain the legacy operator-post path; or add one narrow combined preview that freezes the complete conditional decision and candidate before mandatory post-decision Sol and Terra review. The legacy path preserves the old boundary but requires a fresh run; the bounded route avoids that repetition while retaining every downstream gate and publication proof.
*Recommendation:* Adopt the narrow combined route only after the independent current-repository Issue, checkout, and resolver antecedent and exactly five decision conditions; freeze one complete nine-field target-specific readiness-blocking scope-freeze AC-DECISION record (for example `DEC-56-SCOPE-FREEZE-001`). The target-specific record is distinct from the repository contract decision `DEC-I15-ROUND-BUDGET-001` and is never that record. Preserve CL-D31 serialization and all unrelated routes.
*Owner choice:* Adopt the Issue #15 combined route with a target-specific conditional scope-freeze AC-DECISION record and the dormant at-most-one counted Sol round selected by `DEC-I15-ROUND-BUDGET-001`, with no implementation-start authority.
*Rationale:* The combined response binds one complete byte-identical candidate and conditional nine-field decision. It authorizes no mutation until unchanged Sol and Terra `MERGE`, and the existing Snapshot A / optional PATCH / B / one ledger POST / C proof succeeds.
*Validity and invalidation conditions:* This is a later CL-D32 extension to CL-D31 for the two equivalent Issue entrypoints only. Any candidate, body, diff, ledger, target, resolver, checkout, identity, base-spec, nonce, session, or owner-decision change; any gate finding requiring correction, non-`MERGE`, correlation mismatch, or gate uncertainty; and any tool/provider/capture failure, uncertainty, terminal outcome, replay, transfer, retry, or later command expires the approval and dormant grant. A fresh exact candidate and owner response are required.

The CL-D32 route remains prose-only orchestration with no executable controller, extension, durable resume state, retry, compensation, or provider lock. Its dormant grant permits no Terra, publication, retry, correction, transfer, replay, or further extension. It never publishes a standalone scope-freeze decision; specifically, it never publishes a standalone target-specific scope-freeze decision. The complete target-specific AC-DECISION record is transported exactly once inside the final ledger POST and observed by Snapshot C; `DEC-I15-ROUND-BUDGET-001` remains the separate repository contract decision selecting dormant-round semantics. Foreign Issues remain review-and-draft-only even when all five decision conditions hold; PR/CL-D30, legacy CL-D31, equivalent entrypoints, physical-attempt correlation, and every unlisted mutation prohibition remain unchanged. The exact affirmative response changes only logical owner-choice truth and grant state; it never changes candidate, body, diff, ledger, or decision bytes. After matching gates it preserves only CL-D31's optional current-Issue body PATCH and one exact ledger POST; it grants no additional or unlisted GitHub/provider authority and no implementation, repository-file, Git, commit, push, PR, merge, or implementation-start authority.

## CL-D33 — Review-only drafts guarded owner-executed PR publication artifacts
**Clauses:** CL-D33-boundary, CL-D33-artifacts, CL-D33-marker, CL-D33-guards, CL-D33-post, CL-D33-portability, CL-D33-status, CL-D33-packaging

*Decision ID:* CL-D33
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#41` at the current Issue #41 body
*Question:* How can PR review-only offer safe owner publication of its aggregate review summary without acquiring publication authority itself?
*Options and trade-offs:* Keep manual copy-and-paste; let review-only post directly; or draft two external temporary artifacts with a fingerprint-bound owner-executed publisher. Manual copying is error-prone, direct posting violates the review-only boundary, and the bounded artifacts preserve non-mutation while making the owner grant explicit.
*Recommendation:* Adopt the Issue #41 guarded `review-comment.md` and `publish-review.sh` artifacts with one exact full-URL `gh pr comment` operation.
*Owner choice:* Implement the current Issue #41 contract: review-only drafts the artifacts but never executes or posts; the owner executing the printed Bash command supplies the publication grant.
*Rationale:* Constrained metadata, canonical visible-body and complete-artifact digests, exact target/head checks, complete paginated duplicate detection, one-shot POST behavior, and an external receipt make the later owner action explicit and fail closed without importing source-reply authority.
*Validity and invalidation conditions:* Applies only to PR review-only aggregate-summary publication artifacts. It never grants review-only direct provider mutation, Issue publication, source-finding replies, reviews, approvals, thread resolution, retries, reconciliation, or any autofix action. Any metadata, body, target, lifecycle, head, evidence, digest, POST, or receipt ambiguity stops the script; a later command is a fresh owner action.

The implementation must preserve the exact `gh pr comment <full-pr-url> --body-file <review-comment.md>` operation, use complete UTF-8/LF bytes, and keep the template package-owned while `agents/**`, shared references, and exact autofix authority remain unchanged.

## CL-D34 — Sol findings are anchored to acceptance criteria and a declared threat model
**Clauses:** CL-D34-anchor, CL-D34-payload, CL-D34-classes, CL-D34-threat-model, CL-D34-normalization, CL-D34-readme, CL-D34-baseline

*Decision ID:* CL-D34
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#51` at the current Issue #51 body, motivated by the PR #48 review trajectory
*Question:* How can Sol keep attempting adversarial falsification without letting body-only absolute wording or environment-hostile counterexamples reopen a bounded PR indefinitely?
*Options and trade-offs:* Leave CL-D29 unbounded; drop the adversarial check; or keep the search unbounded but anchor severity and disposition to acceptance criteria, contract clauses, fail-stop invariants, and a mode-declared threat model. Unbounded severity produced one new blocker per fresh run on PR #48 after four `MERGE` verdicts; dropping the check loses falsification; anchoring keeps every counterexample reported while bounding what can block.
*Recommendation:* Adopt anchoring classes `criterion-anchored`, `reword`, and `follow-up`, an exact-autofix threat model, and settled-ledger normalization of new blocker keys.
*Owner choice:* Adopt CL-D34 as recommended for every Sol route, with the threat model declared only by exact PR `autofix`; raise the six-file authority baseline from 99,182 to 108,000 bytes because the previous ceiling left eight bytes and the anchoring, class, and threat-model prose belongs inside the reviewed authority graph rather than in an unreviewed reference. The new value is chosen with headroom above this decision's own prose so an ordinary correction round does not force a second baseline change.
*Rationale:* CL-D29's procedure is preserved verbatim; only severity and disposition are bounded. `Blocker`/`Major` findings must name the anchor their counterexample falsifies or that unavailable required evidence prevents verifying, so both CL-D29 finding bases stay representable without a fourth class; `reword` returns body prose to the owner, `follow-up` routes assumption-violating counterexamples to `deferred` with a proposed issue title, and the parent maps a same-class counterexample to the settled key instead of minting a new one, so the third-observation breaker can fire. The disposition vocabulary stays closed; anchoring is a class, not a disposition. Agent files, review-only, and Issue routes gain no threat model.
*Validity and invalidation conditions:* Applies to every Sol invocation composed under CL-D29 and to exact-autofix blocker-key assignment. It grants no new mutation, retry, resume, or publication authority and changes no round budget. A criterion that names an operator condition removes that condition from the threat-model exclusion. Any later owner decision to widen or narrow the threat model, add a class, or change the baseline requires a new record; the byte baseline is a review guard with deliberate headroom, not a target.

## DEC-I15-ROUND-BUDGET-001 — Bounded post-decision Sol round
**Clauses:** DEC-I15-round-budget
*Decision ID:* DEC-I15-ROUND-BUDGET-001
*Kind:* Scope and bounded workflow-authority decision
*Target and revision:* `tetsuh/pi-tidd-agents#15` at base `issue_spec` `7f8288e4293875a7764436569d57ac974cd4a50d6b6bf64af08c4e9476eaa384`; the proposed Issue revision that incorporates the selected dormant-round semantics.
*Question:* Should a scope decision raised on the last authorized Sol round be excluded from the combined path, or should the exact combined response carry one dormant bounded post-decision Sol round?
*Options and trade-offs:* Option A: fail-closed exclusion, preserving existing round authority but retaining a second-response edge case. Option B: one dormant at-most-one counted Sol round bound to the exact candidate/session, adding narrow review-budget authority while preserving one-response routing.
*Recommendation:* Option B: include the dormant bounded round in the exact combined response, activate it only when no already-authorized round remains, and forbid retry, transfer, mutation authority, or further extension.
*Owner choice:* Option B approved by the exact live same-session response `推奨案を承認`.
*Rationale:* The last-round boundary must not undermine one-response routing. Option B removes that branching without skipping Sol, Terra, snapshots, or publication guards and grants no provider or implementation mutation.
*Validity and invalidation conditions:* Valid for the selected semantics in this Issue #15 revision and later faithful implementation until a later explicit owner-approved decision changes them. Candidate regeneration that preserves these semantics does not change this owner choice; any semantic expansion, additional round, retry, transfer, replay, durable resume, different candidate/session use, or changed authority requires a new owner decision. Before publication, authoritative target/input movement still invalidates the CL-D31 candidate and publication authority.

## DEC-I13-ENTRYPOINT-029 — Equivalent Issue entrypoints
**Clauses:** DEC-I13-ownership, DEC-I13-decision, DEC-I13-publication
*Decision ID:* DEC-I13-ENTRYPOINT-029
*Kind:* public command contract and publication-authority boundary
*Target and revision:* `tetsuh/pi-tidd-agents#13` at the proposed revision based on published base `issue_spec` `7f527af828599860c4dcf2651c0bd329bca09e67c0c565dcf7e1616a2d5af0b7`
*Question:* Should direct `/skill:closed-loop-issue <ref>` invocation receive the same bounded publication authority as `/tidd-issue <ref>`?
*Options and trade-offs:* Treat the two entrypoints as equivalent and preserve one shared Skill contract, or keep direct Skill invocation review-only with a separate reliable fail-closed dispatcher. Equivalence preserves documented same-workflow behavior; divergence requires a new authority discriminator and separate documentation and tests.
*Recommendation:* Treat both spellings as equivalent Issue entrypoints with the same bounded authority and fresh-run semantics.
*Owner choice:* Equivalent entrypoints; authorize the same bounded Issue publication and recovery semantics through `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>` only.
*Rationale:* Both commands load the same authoritative Skill and are documented as the same workflow. Equivalence is the smallest consistent authority boundary and does not grant publication to PR commands, other aliases, foreign repositories, or unlisted actions.
*Validity and invalidation conditions:* This decision applies only to the two named Issue entrypoints and the Issue #13 bounded exception. It remains valid until a later explicit owner-approved contract decision separates the entrypoints or changes their shared Skill architecture.

## DEC-EXT-SNAPSHOT-001 — External observation resumes by re-fetching
**Clauses:** none — structural
*Decision ID:* DEC-EXT-SNAPSHOT-001
*Kind:* contract
*Target and revision:* #6 at `0f8bd00`
*Question:* CL-D24 and CL-D13 required a digest of observed external events so a resume could detect edits, while CL-D28 removed that byte-exact specification from this MVP.
*Options and trade-offs:* Define a canonical event serialization in the Skill; withdraw the digest and re-fetch on resume; or defer external resume until #4. Defining serialization repeats the under-specified prose machinery rejected by CL-D28, while deferring resume loses honest observation continuity.
*Recommendation:* Withdraw the digest and re-fetch current external evidence on every resumed or later run.
*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.
*Rationale:* The origin is the only value a resume cannot re-derive, but the latest event time and event content return from live data. The narrowed decision avoids provider-specific identity and serialization design in this MVP; unknown provider identity, timestamp, or head association remains non-passing.
*Validity and invalidation conditions:* Holds while the MVP reports rather than enforces the observation window and takes a fresh snapshot on every run. If #4 enforces timing or needs to distinguish edits from re-fetches, revisit this decision with code.

Its outcome is enforced by `CL-D24`. Renovating the record preserves the final amended choice from the authoritative #3 decision comment; the comment remains historical context and is not an additional source of current contract ownership.

---

## AC-AUTOFIX — Autofix token grants only bounded CL-D30 actions
**Clauses:** AC-AUTOFIX, SOL-PR14-CONTRACT-001-autofix

Without the exact PR `autofix` token, Issue and PR review-only remain file-mutation-free and publication-free before candidate construction and outside CL-D31. During CL-D31, its named same-session approval is the only Issue grant. The exact PR token itself is the run-scoped approval only for the smallest CL-D30 correction batch per reviewed public head: one normal commit, one non-force push, and `REPLY_EXCEPTION`. It does not authorize merge, force-push, amend, rebase, history rewriting, or provider mutation other than `REPLY_EXCEPTION` and CL-D31 optional body PATCH/ledger POST; it does not authorize approval, thread resolution, authoritative Issue changes, aggregate-summary posting, or any different target.

## AC-DECISION — Owner decision record
**Clauses:** AC-DECISION, AC-DECISION-pr, AC-DECISION-issue-scope, AC-DECISION-pr-scope

Nine fields: Decision ID, Kind, Target and revision, Question, Options and trade-offs, Recommendation, Owner choice, Rationale, Validity and invalidation conditions. Questions are asked one at a time.

## AC-DISPOSITION — Finding disposition ledger
**Clauses:** AC-DISPOSITION, AC-DISPOSITION-issue, AC-DISPOSITION-pr

Every actionable finding gets exactly one of `fixed`, `accepted-as-designed`, `deferred`, `duplicate`, `not-applicable`, `needs-owner-decision`, with the full record for each. The enumerations are pinned whole and scoped to their section: field names matched individually were satisfied by unrelated prose elsewhere in the file, so a record could lose a column silently.

## AC-GATES — Sequential Sol then Terra
**Clauses:** AC-GATES

The Terra gate never starts before the Sol gate returns `MERGE`.

## AC-GRANT — Run-scoped bounded publication grant
**Clauses:** AC-GRANT, SOL-PR14-CONTRACT-001-grant

Historical rationale: this grant was originally documented for a later publication stage rather than exercised by the review-only MVP. Current rule: the exact PR `autofix` token itself supplies the run-scoped grant only for CL-D30's bounded one-normal-commit/non-force-push correction batch per reviewed public head and `REPLY_EXCEPTION`. Separately, CL-D31 supplies a same-session Issue grant only for its exact preview, optional body PATCH, and one ledger POST. Neither grant authorizes merge, force-push, amend, rebase, history rewrite, ADR acceptance, failed-gate bypass, or provider mutation other than `REPLY_EXCEPTION` and CL-D31 optional body PATCH/ledger POST; neither authorizes aggregate-summary posting or a different target; each expires at its scoped terminal boundary.

## AC-ISSUE-NO-EXTERNAL — Issue readiness excludes external gates
**Clauses:** AC-ISSUE-NO-EXTERNAL

External review services, static-analysis sites and pull-request checks are not part of issue readiness.

## AC-REVIEW-ONLY — Review-only is the default
**Clauses:** AC-REVIEW-ONLY-skill

Without the exact `autofix` token, and before candidate construction or outside CL-D31, no file edits, no git-state changes, no commits or pushes, no posting to GitHub, no replies to review threads, and no external mutation. CL-D31 is the sole named Issue exception and does not alter PR review-only.

## AC-TDD — Risk-based test-first policy and truthful provenance
**Clauses:** AC-TDD, AC-TDD-issue-quality-gate

Coverage is classified as pre-implementation behavioural RED, pre-implementation compile/contract RED, co-developed integration coverage, review-driven regression, or retrospective reproduction. RED evidence is never fabricated and history is never rewritten to simulate chronology.

The two pre-implementation classes are separated by what a test does, not by where its inputs come from: inspecting an artifact's content or structure is compile/contract; executing the thing being specified and observing what it does is behavioural, wherever that thing lives. Assertion polarity is irrelevant. This is written down because the call was got wrong four times, and because the first attempt at the rule was itself too broad — it separated the classes by input origin, which would misclassify a unit test importing a module from this repository.

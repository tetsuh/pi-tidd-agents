# Pi TiDD Agents

A small collection of role-focused [Pi](https://github.com/badlogic/pi-mono) subagents that makes Ticket-Driven Development a little more convenient.

TiDD means **Ticket-Driven Development** here: review the ticket, preserve its decisions, implement the scoped work, and review the pull request before merging.

This package is intentionally small. It does not define a TiDD standard and it does not automate an issue tracker: **no workflow is forced by default**, and an opt-in closed-loop workflow is available for teams that want one. Everything else is a handful of practical agent definitions for teams that already develop from tickets and pull requests.

## Requirements

- Pi
- [pi-subagents](https://github.com/nicobailon/pi-subagents) **0.36.0 or newer** (0.36.0 validated for this package)
- Access to the model identifiers used by the selected agents

Requirements differ between the two ways of using this package:

| Use | Requirement |
| --- | --- |
| Standalone agents | À la carte. Run whichever agents resolve in your environment; an unavailable model affects only that one agent. |
| Closed-loop workflow | Composes a fixed set of four agents. The complete loop needs all four; a single command needs only the agents in its own preflight. |

The closed-loop workflow uses `sol-reviewer` (`gpt-5.6-sol`), `terra-oracle` (`gpt-5.6-terra`), `terra-reviewer` (`gpt-5.6-terra`), and `luna-worker` (`gpt-5.6-luna`), which are OpenAI GPT-5.6 Sol, Terra, and Luna. `glm-worker` is not used by the closed-loop workflow and remains a standalone agent.

Per command: `/tidd-issue` preflights `sol-reviewer` and `terra-oracle`; `/tidd-pr` preflights `sol-reviewer` and `terra-reviewer`, and adds `luna-worker` in `autofix` mode.

The skills name agents by runtime name and never by model ID. User and project agent definitions take discovery precedence over package-provided definitions with the same runtime name, so if your environment does not offer these models you can still run the workflow by defining your own `sol-reviewer`, `terra-oracle`, `terra-reviewer`, and `luna-worker`.

Install `pi-subagents` first (the package was validated with 0.36.0; do not assume support for older versions):

```bash
pi install npm:pi-subagents
```

## Installation

Install from a local checkout:

```bash
pi install ~/git/pi-tidd-agents
```

After the repository is published, it can also be installed from Git:

```bash
pi install git:github.com/<owner>/pi-tidd-agents
```

## Included agents

| Agent | Model | Purpose |
| --- | --- | --- |
| `luna-worker` | `gpt-5.6-luna` | General implementation work |
| `terra-worker` | `gpt-5.6-terra` | Implementation work with an emphasis on low-level correctness |
| `glm-worker` | `glm-5.2` | Alternative implementation worker |
| `sol-reviewer` | `gpt-5.6-sol` | Read-only requirements, contract, scope, and maintainability review |
| `terra-reviewer` | `gpt-5.6-terra` | Read-only concurrency, lifetime, ownership, and portability review |
| `terra-oracle` | `gpt-5.6-terra` | Read-only decision-drift and contradiction review |

## Simple usage

Ask Pi to delegate in ordinary language:

```text
Use sol-reviewer to review Issue #18 and append pre-implementation notes.
```

```text
Use luna-worker to implement Issue #18 and create a pull request.
```

For a typical Issue-to-pull-request workflow, use the following sequence.

## Typical TiDD flow

| Stage | Agent | Example prompt |
| --- | --- | --- |
| Issue pre-implementation notes | `sol-reviewer` | `Use sol-reviewer to review Issue #18 and append pre-implementation notes.` |
| Issue pre-implementation addendum | `terra-oracle` | `Use terra-oracle to review Issue #18 and append a pre-implementation addendum.` |
| Implementation and pull request | `luna-worker` | `Use luna-worker to implement Issue #18 and create a pull request.` |
| Standard pull request review | `sol-reviewer` | `Use sol-reviewer to review PR #42 and append the review.` |
| Concurrency, lifetime, and ownership review when relevant | `terra-reviewer` | `Use terra-reviewer to review PR #42 for concurrency, lifetime, and ownership issues, then append the review.` |
| Address approved pull request findings | `luna-worker` | `Use luna-worker to address the approved findings on PR #42 and push the fixes.` |

The reviewer and oracle agents remain read-only. The parent Pi session is responsible for any requested issue or pull-request comment.

## Closed-loop workflow (opt-in)

The closed-loop workflow runs the stages above as a loop: review, disposition every finding, apply only authorized fixes, and revalidate the evidence the change invalidated. It is opt-in. Installing the package starts nothing and changes nothing.

The existing Sol review gate also runs an adversarial consistency check: it treats the exact issue/PR body, current authoritative decision record/comments, and applicable Skill assertions as claims to verify against authoritative files, not as context. The separate agent's primary benefit is model-family diversity; it may also add independent context, system-prompt, and failure boundaries. This adds no gate, agent, mode, verdict, status token, round budget, prompt, package, or agent-file change. Agent files remain frozen; CL-D35 approves one removal of an unloaded tool for Issue #49 and grants no standing permission to change them. Under CL-D34, every blocking Sol finding is anchored to an acceptance criterion, contract clause, or fail-stop invariant; body-only absolute wording is a `reword` finding, and counterexamples outside the exact-autofix threat model are `follow-up` findings, so adversarial review bounds severity without weakening falsification.

```text
/tidd-issue <issue-ref>
/tidd-pr <pr-ref> [autofix]
```

The same workflows are available directly as skills when skill commands are enabled in your Pi settings:

```text
/skill:closed-loop-issue <issue-ref>
/skill:closed-loop-pr <pr-ref> [autofix]
```

An explicit target is always required; the workflow never infers a pull request from the current branch.

### Owner-gated Issue candidate publication

Issue readiness remains opt-in and is exposed through the equivalent `/tidd-issue <issue-ref>` and `/skill:closed-loop-issue <issue-ref>` entrypoints. In the ordinary CL-D31 route, a complete candidate is reviewed by Sol then Terra before the Skill shows one exact frozen preview containing the full body diff and English disposition ledger. Only the current session operator's exact response can authorize the bounded attempt.

#### Combined scope-freeze approval

CL-D32 adds a narrow combined route. An eligible current-repository Issue may show one exact combined scope-freeze preview before post-decision rereview: one exact owner response binds or conditionally approves the already-frozen complete decision-containing candidate, then mandatory Sol rereview and Terra review occur in that order. A dormant at-most-one counted Sol round activates only when the decision arose on the last already-authorized Sol round; otherwise it remains unused. The target-specific scope-freeze decision is never a standalone comment: after matching gates, existing Snapshot A, optional body PATCH, Snapshot B, one ledger POST, and Snapshot C proof remain mandatory. The route does not authorize starting implementation. Foreign Issues, PR/CL-D30, legacy decisions, and all other boundaries remain unchanged.

The bounded attempt may perform at most one optional body update in the current checkout repository followed by one ledger comment, in that order. There is no retry or compensating overwrite after failure; deletion, cross-session resume, and a second attempt remain prohibited. A failure after the first mutation reports the observed partial state and requires a fresh run. Foreign-repository Issues remain review-and-draft-only. Snapshot-C byte/content identity may establish readiness without duplicate gates, but the proof is observational and cannot exclude every provider race. This is legacy Skill/prompt orchestration, not an executable controller or extension. PR review-only and exact PR `autofix` behavior, including Luna ownership and their separate boundaries, remain unchanged.

### Review-only is the default

```text
/tidd-pr 42
```

Reviews the pull request without editing files, changing git state, committing, pushing, posting to GitHub, or touching any external service. Replies and patches are drafted for you to review, not published.

When a publishable aggregate summary is available, review-only may also draft `review-comment.md` and `publish-review.sh` in a temporary directory outside the repository. It prints the exact owner command `bash "<path>/publish-review.sh"`; review-only never executes it. The generated publisher rechecks the exact repository, open PR, reviewed head, complete body digest, and all paginated duplicate-marker evidence before one owner-authorized `gh pr comment` operation. Any head change requires a fresh review, and failed or ambiguous publication is never retried automatically.

### Autofix

Issue #42 isolated-workspace authority applies to exact autofix. Issue #47 helper protocol v1 packages bounded zero-dependency CommonJS helpers under `skills/closed-loop-pr/helpers/`; exact autofix invokes `node <installed-skill-dir>/helpers/cli.js` with a versioned JSON request and consumes one strict structured result. The helpers provide conservative complete-policy writability evaluation, deterministic CL-D9 fingerprints, bracketed paginated GitHub evidence, operator-checkout observation, and isolated workspace lifecycle operations. They never commit, push, reply, merge, or mutate GitHub; only isolated workspace creation and identity-guarded linked-worktree cleanup mutate Git administration, and clone fallback artifacts are retained and reported rather than deleted. Helper failure remains terminal with no automatic retry, and discrete filesystem observations do not claim continuous race immunity.

```text
/tidd-pr 42 autofix
```

The exact token `autofix`, lowercase, is the only way to permit file edits. Anything else — `Autofix`, `--autofix`, an extra argument — stops with usage rather than quietly downgrading. The operator branch must already be checked out, but it is never the writer workspace and the workflow never switches it.

Exact PR `autofix` separates `OPERATOR_CHECKOUT@H` from `AUTOFIX_WORKSPACE@H`; initial `H` becomes immutable operator baseline `O`. `OPERATOR_CHECKOUT_UNCHANGED@O` guards pre-push boundaries; post-push `WORKSPACE_POST_PUSH(C, O)` permits only the verified remote-tracking transition `O -> C`, and only then may `operator_revalidate` receive `postPushHead: C`. The operator keeps clean tracked/index state and blocks every unexpected non-ignored untracked path; ignored paths use an opaque sorted ignored inventory explicitly enumerated as NUL-delimited normalized checkout-relative lexical paths plus no-follow kind, with stable re-enumeration and no contents, targets, sizes, timestamps, or hashes read. Exact `RUNTIME_ROOTS := { ".pi", ".pi-subagents" }` is excluded from that inventory and keeps independent no-follow rules. Runtime-root entries in candidate `HEAD`, index, correction, manifest, commit, or published tree fail closed; safe untracked churn is separately reclassified. A detached linked worktree at exact `H` is primary (`git worktree add --detach`); a temporary clone is fallback only after unavailable creation and proof of no side effect. Every Git command and all gates/writer/validation use exact isolated cwd, sanitized noninteractive execution, explicit config isolation, empty run-owned hooksPath, and no inherited helper/filter/fsmonitor/signing/pager/editor execution. Source/origin/fetch/push/repository/branch identity is bound; publication is normal non-force `HEAD:refs/heads/<verified-pr-branch>` without local PR-ref movement. `WORKSPACE_POST_COMMIT(C, P)` and `WORKSPACE_POST_PUSH(C, O)` are distinct. AFTER_COMMIT and BEFORE_PUSH independently reclassify every `RUNTIME_ROOTS` member. Validation-created ignored caches are frozen sandbox-only state and never enter correction/evidence/manifest/commit/publication. Every terminal result rechecks the operator; successful push reports `O -> C` behind without reconciliation. After success or failure, optional cleanup is exact identity-reverified non-force `git worktree remove` for a linked workspace only; never recovery, compensation, force, prune, recursive deletion, clean, clone deletion, or operator cleanup.

CL-D40: A missing path does not prove a stale worktree registration. Fresh workspace creation ignores unrelated missing registrations and reports an exact collision or partial creation with read-only identity evidence; it must never recommend `git worktree prune`. Only evidence proving the intended repository, exact missing non-symlink path, detached expected HEAD, unlocked state, and registration permits a drafted non-force `git worktree remove <exact-path>` as a separate owner action. Ambiguous identity yields no mutation command, and any completed external removal requires a fresh run.

`pi-subagents` 0.36.0+ accepts `artifactDir: "session"` and `artifactDir: "temp"`; these are optional ways to move artifact and chain-run output outside the working directory. They do **not** guarantee that `.pi-subagents/` is absent: beginning with supported `pi-subagents` 0.41.0 (verified against installed 0.42.1), default-on project missions may persist records under `.pi-subagents/missions` independently of `artifactDir`. The default configuration must work, and these options are not a substitute for the runtime-root contract.

Autofix selects the bounded public-head loop in the Skill. `luna-worker` is always the mandatory sole writer/publisher: it performs at most one correction batch per reviewed public head, one normal commit, and one non-force push. A request for any other worker stops before mutation, ends the exact-autofix run, and has no resume because it would change the CL-D30 contract. Every push restarts at Sol. Standalone explicit worker delegation outside this `/tidd-pr ... autofix` workflow remains separate and receives no CL-D30 authority. `terra-worker` is excluded because its model also grades the Terra gate, and `glm-worker`, whose model does not grade a gate either, would add a second model family to the requirement. Exact identity guards, immutable run-local records, finding replies, circuit breakers, and fail-stop behavior are defined only by the Skill.

### Bounded publication

In exact `autofix` mode, `luna-worker` is the sole writer/publisher for one bounded normal correction commit and one non-force push per reviewed public head. Every successful push invalidates prior approvals and restarts at Sol. The parent is the only GitHub comment actor and may post only confirmed, source-bound finding replies; the aggregate final summary remains a separate owner-approved one-shot action. All publication authority is run-scoped. Exact autofix owns complete identity guards, staged manifests, deterministic circuit breakers, immutable run-local records, and fail-stop/no-retry/no-resume behavior. Review-only mode and Issue behavior remain unchanged. One pull request is additionally bounded across fresh runs (CL-D41) by a derived accounting key of repository, pull-request number, and base OID: the branch may carry at most 10 correction commits per key before exact autofix stops for an owner decision instead of starting another run, and base movement starts a new key. That bound is derived from the pull request itself at each snapshot, so no workflow state is stored between runs, and the per-run limits are unchanged.

### Stop, status, and fresh runs (CL-D30)

PR review-only retains the legacy resumable `tidd-status`, one malformed-verdict retry, and per-gate three-round accounting; it may report a next action and resume after fingerprint revalidation. Exact PR `autofix` ends on interruption, failure, owner decision, or limit: apart from the one bounded pre-writer recovery CL-D39 defines, it has no retry, resume, outbox, scheduler, quiet-period polling, or durable workflow artifact. Any later exact-autofix command is a fresh run with fresh counters and reconciliation. Issue behavior is governed by the Issue Skill: its CL-D31 exception is limited to the two equivalent Issue entrypoints and does not change PR behavior.

### Language routing

Language is chosen by destination, not by reviewer. Conversation follows the language you are using; GitHub issue and pull-request content defaults to English; an external site with no configured language stops and asks before anything is drafted for it. Source code, code comments, repository documentation, and commit messages always follow your project's own instructions.

## Worker permissions

Workers can edit files and run tests, but they do not commit, push, create branches or pull requests, rewrite history, post to GitHub, or resolve review threads unless the delegated task explicitly authorizes the relevant action.

For example:

```text
Use luna-worker to implement Issue #18.
```

This permits implementation and validation, but not a local commit.

```text
Use luna-worker to implement Issue #18 and create a pull request.
```

This authorizes the parent workflow to delegate the required local commits, push, and pull-request creation. It does not authorize merging or history rewriting.

## Model overrides

The included definitions use provider-unqualified model IDs. Pi resolves each ID through the active provider when that provider offers it. If a model is unavailable in your environment, copy or override the agent definition through `pi-subagents` configuration before running it.

User and project agent definitions have higher discovery precedence than package-provided definitions with the same runtime name.

## Design

- Workers use forked conversation context and inherit project instructions.
- Reviewers use fresh context and have read-only tool allowlists.
- The oracle uses forked context to reconstruct inherited decisions and detect drift.
- External side effects require explicit delegation.
- Agent runtime names stay short and unqualified.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

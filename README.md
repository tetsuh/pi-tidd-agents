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

The existing Sol review gate also runs an adversarial consistency check: it treats the exact issue/PR body, current authoritative decision record/comments, and applicable Skill assertions as claims to verify against authoritative files, not as context. The separate agent's primary benefit is model-family diversity; it may also add independent context, system-prompt, and failure boundaries. This adds no gate, agent, mode, verdict, status token, round budget, prompt, package, or agent-file change.

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

### Review-only is the default

```text
/tidd-pr 42
```

Reviews the pull request without editing files, changing git state, committing, pushing, posting to GitHub, or touching any external service. Replies and patches are drafted for you to review, not published.

### Autofix

```text
/tidd-pr 42 autofix
```

The exact token `autofix`, lowercase, is the only way to permit file edits. Anything else — `Autofix`, `--autofix`, an extra argument — stops with usage rather than quietly downgrading. Autofix requires the pull request's branch to be checked out already; the workflow never switches branches for you.

Autofix selects the bounded public-head loop in the Skill. One worker writes and publishes, and it is `luna-worker` by default: it performs at most one correction batch per reviewed public head, one normal commit, and one non-force push. Every push restarts at Sol. `terra-worker` is excluded because its model also grades the Terra gate, and `glm-worker`, whose model does not grade a gate either, would add a second model family to the requirement. Exact identity guards, immutable run-local records, finding replies, circuit breakers, and fail-stop behavior are defined only by the Skill.

### Bounded publication

In exact `autofix` mode, `luna-worker` is the sole writer/publisher for one bounded normal correction commit and one non-force push per reviewed public head. Every successful push invalidates prior approvals and restarts at Sol. The parent is the only GitHub comment actor and may post only confirmed, source-bound finding replies; the aggregate final summary remains a separate owner-approved one-shot action. All publication authority is run-scoped. Exact autofix owns complete identity guards, staged manifests, deterministic circuit breakers, immutable run-local records, and fail-stop/no-retry/no-resume behavior. Review-only mode and Issue behavior remain unchanged.

### Stop, status, and fresh runs (CL-D30)

PR review-only retains the legacy resumable `tidd-status`, one malformed-verdict retry, and per-gate three-round accounting; it may report a next action and resume after fingerprint revalidation. Exact PR `autofix` ends on interruption, failure, owner decision, or limit: it has no retry, resume, outbox, scheduler, quiet-period polling, or durable workflow artifact. Any later exact-autofix command is a fresh run with fresh counters and reconciliation. Issue behavior remains governed by the Issue Skill.

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

# Pi TiDD Agents

A small collection of role-focused [Pi](https://github.com/badlogic/pi-mono) subagents that makes Ticket-Driven Development a little more convenient.

TiDD means **Ticket-Driven Development** here: review the ticket, preserve its decisions, implement the scoped work, and review the pull request before merging.

This package is intentionally small. It does not define a TiDD standard, enforce a workflow, or automate an issue tracker. It only provides a few practical agent definitions for teams that already develop from tickets and pull requests.

## Requirements

- Pi
- [pi-subagents](https://github.com/nicobailon/pi-subagents)
- Access to the model identifiers used by the selected agents

Install `pi-subagents` first:

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
Use sol-reviewer to pre-review Issue #18 and append the result to the issue timeline.
```

```text
Use terra-oracle to check Issue #18 and its pre-review for decision drift.
```

```text
Use luna-worker to implement Issue #18 and create a pull request.
```

```text
Use sol-reviewer and terra-reviewer to review PR #42 in parallel and append a consolidated review comment.
```

The reviewer and oracle agents remain read-only. The parent Pi session is responsible for any requested issue or pull-request comment.

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

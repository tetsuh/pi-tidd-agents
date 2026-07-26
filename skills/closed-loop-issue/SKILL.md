---
name: closed-loop-issue
description: Drive a GitHub issue to IMPLEMENTATION_READY through sequential read-only requirements and decision-drift gates, recording finding dispositions, owner decisions, and evidence fingerprints. Use only when the operator explicitly runs /tidd-issue or /skill:closed-loop-issue with an issue reference.
---

# Closed-loop issue readiness

Take one GitHub issue from specification to `IMPLEMENTATION_READY` by reviewing it, dispositioning every finding, revising the specification, and revalidating the current authoritative revision.

You are the orchestrator. Formal gates run as read-only subagents. This skill never merges anything and never becomes an autonomous editor.

## Precondition guard (CL-D20)

This skill runs only against an explicit target supplied by the operator.

If no issue reference was supplied, stop and print usage:

```text
/tidd-issue <issue-ref>
```

Do not infer a target, do not scan for candidate issues, and do not start any gate. Report `BLOCKED` and end the run.

## Preflight (CL-D22, CL-D5)

Before the first gate, confirm the runtime can actually complete the workflow.

1. Subagent execution comes from `pi-subagents`. If `pi-subagents` is unavailable, stop and report `BLOCKED` with installation guidance. Never substitute your own execution for a formal gate.
2. Confirm that the required agents resolve: `sol-reviewer` and `terra-oracle`.
3. Refer to agents **by runtime name** only, **never by model ID**. User and project agent definitions take discovery precedence over package-provided ones with the same runtime name, so an operator whose environment lacks a model can supply their own definition under the same name through the name-level override guidance. Naming a model here would remove that escape hatch.
4. If a required agent does not resolve, stop and report `BLOCKED`, naming the missing agent and the override path. Do not begin a gate that cannot finish.

A preflight failure is not a review round.

## Target resolution (CL-D7, CL-D8)

Accept a full GitHub URL, `#123`, `123`, `Issue #123`, `PR #123`, or `PR123`.

The prompt template passes the complete raw argument vector (`$@`) to this Skill. Parse it before calling `gh`: recognize `Issue`/`PR` followed by `#123` as one two-token reference, recognize the other forms as one token, and reject any remaining token. Resolve the reference with `gh`. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence, so a number alone does not identify the kind. If the reference resolves to a pull request, stop and tell the operator to use `/tidd-pr`. The target is **never inferred from the current branch**.

A target in **another repository** may be reviewed, but nothing may be published to it and no local work may be started for it. Publication authority is bound to the repository of the current checkout.

## Evidence fingerprints (CL-D9)

Record the identity of what you reviewed, so later evidence is invalidated only where it no longer applies.

- `issue_spec` — `sha256` over canonical UTF-8 bytes consisting of the issue body record followed by each authoritative comment rendered as `<id>:<updatedAt>:<body>`, ordered by comment id ascending, with records joined by one LF (`0x0a`) and no trailing separator. Normalize CRLF and CR in text fields to LF before encoding. Do not let shell locale, Git configuration, or platform newline conversion alter the bytes.

Use `LC_ALL=C`, `printf '%s'`, explicit UTF-8 input, and `sha256sum` (or an equivalent command that hashes the exact byte stream) to compute the digest. **Never estimate or invent a digest value**: a digest you did not actually compute makes the resume check meaningless, and an unstable value raises false "target changed" alarms on a target that never moved.

An **authoritative comment** is one whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` and whose author **is not a bot**. Every other comment is advisory context and stays out of the fingerprint.

Recompute `issue_spec` before declaring readiness. If it changed since a gate passed, that gate's result is stale and the gate must run again.

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
- Write issue titles, bodies, comments, decisions, and waivers in `github.issue`.
- Use `github.pull_request` for pull-request destinations.
- For any destination under `external_sites` that has no configured language, **stop and ask before drafting content for that destination** rather than guessing. The trigger is drafting, not posting: this MVP never posts, so a trigger tied to the first post would never fire.
- This profile **never governs source code**, code comments, repository documentation, or commit messages. Those follow project instructions.

Quote source text verbatim when quoting is needed.

## Mutation boundary (CL-D15)

This skill has no autofix mode. For the whole run:

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not post, edit, or close anything on GitHub.

Draft the revised specification in the configured issue language and show it to the operator. This MVP **does not publish**; the operator posts it (CL-D28).

Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**.

## Gate loop (AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The order is fixed and sequential:

```text
specification
→ sol-reviewer gate
→ disposition and revision
→ Sol MERGE
→ terra-oracle gate
→ disposition and revision
→ Terra MERGE
→ IMPLEMENTATION_READY
```

`sol-reviewer` owns requirements, contracts, scope, acceptance, and feasibility. `terra-oracle` then checks the revised specification against inherited decisions for contradiction and drift. **Never start the Terra gate before the Sol gate returns `MERGE`.**

External review services, external static-analysis sites, and pull-request checks **are not part of issue readiness** (AC-ISSUE-NO-EXTERNAL).

### Gate verdicts (CL-D1)

Every gate must end with a verdict line using exactly this vocabulary:

```text
MERGE | FIX BEFORE MERGE | NEEDS DECISION
```

`sol-reviewer` already ends its report with that verdict. **`terra-oracle` has no verdict contract of its own**, so you must require the same verdict line in the invocation payload you send it. **Do not modify any file under `agents/`** to add one: the existing agents must stay unchanged and independently usable.

Only the parsed verdict decides whether a gate passed. Never read approval into prose. **A missing or unparsable verdict is a tool-level failure**: retry the invocation once, and if it fails again report `BLOCKED`.

### Invocation payload (CL-D2)

Every agent in this package sets `inheritSkills: false`, so nothing in this skill reaches a subagent automatically. **Nothing may rely on a child inheriting this skill.** Each invocation must restate:

- the required verdict vocabulary and that the verdict must be the last line;
- that the child is read-only;
- the target, its `issue_spec` fingerprint, and the exact text under review;
- the applicable Language Profile entries;
- the finding format: severity, evidence, impact, and smallest correction;
- the scope boundary, so the child does not redesign approved decisions;
- the acceptance criteria the target must satisfy, so that every finding can be traced to one;
- on a gate re-invocation, every finding from that gate's earlier rounds, plus the dispositioned findings of any gate that already passed, each with its disposition and rationale.

A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is **settled**, and the payload must say so: re-raising one requires new evidence, not a restatement. A finding that traces to no acceptance criterion is an out-of-scope improvement rather than a blocker, and must be labelled that way instead of returning `FIX BEFORE MERGE`.

Without this the loop cannot terminate. Reviewers run with fresh context and `inheritSkills: false`, so a disposition the parent recorded is invisible to the next round, and any finding not literally fixed returns indefinitely.

### Round accounting (CL-D11, CL-D12)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- If a Terra finding forces a change to something Sol already approved, the Sol gate must run again and consumes one of its own rounds.
- At the limit, stop and report `ROUND_LIMIT_REACHED` and ask the owner whether to grant more rounds.

Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block so the owner can carry them forward. **Do not create a state file** to work around this; persistent workflow state is a later stage.

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

For each finding record the source gate, severity, the `issue_spec` it was raised against, evidence, impact, the disposition, the rationale, the revised passage when the disposition is `fixed`, validation evidence that the revision actually resolves the finding, and the reply or status URL once the operator has posted it. The last two are recorded on the later run that reviews the published revision, since this MVP does not publish and the URL does not exist until the operator acts. Judge findings individually; a severity label is never by itself a decision to change the specification. Record the rationale for anything intentionally left unchanged.

Group the report into blockers, changes worth making now, optional improvements, pre-existing conditions, and findings intentionally declined.

## Owner decisions (AC-DECISION)

Pause for the owner on public contracts and APIs, architecture, scope, compatibility and risk trade-offs, policy exceptions, and ADR acceptance. Routine details that an approved contract already settles are yours to decide.

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

Long-lived contract, waiver, and risk decisions belong on the issue in the configured issue language. Draft them and hand them to the operator to post. Operational permissions for a single run stay in the session.

While an owner decision or an owner action is pending, the state is `WAITING_FOR_OWNER`.

## Specification quality bar (AC-TDD)

An issue is not ready until it states its acceptance contract and validation plan. Apply the risk-based test-first default when reviewing that plan, and require it to classify coverage truthfully as one of:

```text
pre-implementation behavioral RED
pre-implementation compile/contract RED
co-developed integration coverage
review-driven regression
retrospective reproduction
```

Require a meaningful behavioral RED for deterministic bug fixes and for behavior exercisable through an existing test seam. Permit truthful co-development for integration scaffolding, new module bootstrapping, platform-only packaging checks, and review-driven regression coverage when a pre-implementation behavioral RED is impractical.

**Never fabricate RED evidence**, and **never rewrite history to simulate** a test-first chronology. Policy precedence is project instructions, then authoritative issue requirements that do not weaken them, then this package default.

The two pre-implementation classes are separated by what the test does, not by where its inputs come from. A test that **inspects an artifact's content or structure** — reading a file and checking for required or forbidden text, parsing frontmatter — is compile/contract RED. A test that **executes the thing being specified and observes what it does** is behavioural RED, and it stays behavioural when the thing it executes lives in this repository. **Assertion polarity is irrelevant**: `doesNotMatch` against a Markdown file is no more behavioural than `match` against one.

Applying that here gives three groups, not two. The `npm pack` assertions **execute the packaging tool and observe** what it actually publishes, which no amount of reading `package.json` would establish, so they are behavioural. The clause and artifact assertions read files and check text, so they are compile/contract. The reference fixtures execute a specification written inside the test itself rather than the artifact under review, so they are neither: they pin intended semantics and cannot verify prose. This is the criterion applied here, not the criterion.
 A recorded owner exception is a narrow override of a named rule and must state its scope, rationale, and invalidation conditions.

## Outcome and status block (CL-D13, CL-D14)

Use these tokens exactly:

```text
IMPLEMENTATION_READY
WAITING_FOR_OWNER
ROUND_LIMIT_REACHED
BLOCKED
ABORTED
```

Declare `IMPLEMENTATION_READY` only when both gates returned `MERGE` against the current `issue_spec`, every finding has a disposition, no owner decision is pending, and **the approved specification is the published specification**.

This MVP does not publish, so a run that drafted an issue revision or a durable decision ends at `WAITING_FOR_OWNER` with that draft, never at readiness: the gates approved text the issue does not yet contain, and `issue_spec` still fingerprints the text it does. After the operator posts it, recompute `issue_spec` and rerun both gates against that exact authoritative text.

Whenever the run stops without reaching readiness, emit a resumable block:

````text
```tidd-status
target: <owner/repo#123>
state: <token>
active_gate: <sol|terra|none>
issue_spec: <digest>
rounds: sol <used>/3, terra <used>/3
findings: <internal finding id: disposition, one per line>
pending_decisions: <decision ids or none>
publication_grant: not-applicable
invalidated_evidence: <what must be redone>
next_action: <the single next permitted action>
```
````

To resume, the operator pastes that block back with the command. On resume, **revalidate the fingerprints** first and refuse to continue against a changed target; recompute instead of trusting the pasted state.

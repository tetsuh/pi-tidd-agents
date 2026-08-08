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

The mode token is the final token of the raw argument vector, evaluated once the target reference has been recognized. A target reference may itself be two tokens, such as `Issue #123` or `PR #123`, so a fixed argument position does not identify the mode. Parsing is exact and fails closed:

- the final token is exactly `autofix`, **case-sensitive** → autofix mode;
- no token remains once the target reference is consumed → review-only mode;
- anything else, including `Autofix`, `AUTOFIX`, `--autofix`, or any token still left over after the reference and an optional final `autofix` → **stop and print usage**.

A near-miss token signals intent to mutate, so it must surface as an error rather than quietly downgrade to review-only.

## Preflight (CL-D22, CL-D5)

1. Subagent execution comes from `pi-subagents`. If `pi-subagents` is unavailable, stop and report `BLOCKED` with installation guidance. Never substitute your own execution for a formal gate, and never edit files yourself in place of a worker.
2. Confirm that the required agents resolve: `sol-reviewer`, `terra-reviewer`, and, conditionally for autofix mode, `luna-worker`.
3. Refer to agents **by runtime name** only, **never by model ID**. User and project agent definitions take discovery precedence over package-provided ones with the same runtime name, so an operator whose environment lacks a model can supply their own definition under the same name through the name-level override guidance.
4. If a required agent does not resolve, stop and report `BLOCKED`, naming the missing agent and the override path. Do not begin a gate that cannot finish.

A preflight failure is not a review round.

## Target resolution (CL-D7, CL-D8)

Accept a full GitHub URL, `#123`, `123`, `Issue #123`, `PR #123`, or `PR123`.

The prompt template passes the complete raw argument vector (`$@`) to this Skill. Parse it before calling `gh`: greedily recognize `Issue`/`PR` followed by `#123` as one two-token reference, recognize the other forms as one token, and treat only a final exact `autofix` as the mode. Reject any remaining token. Resolve the reference with `gh`. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence. If the reference resolves to an issue, stop and tell the operator to use `/tidd-issue`. The target is **never inferred from the current branch**.

A target in **another repository** may be reviewed in review-only mode. Its base/head OIDs, tree values, effective diff, and commit sequence come from the foreign GitHub API endpoints described below, so no local Git object or checkout is required. The same GitHub API evidence path is available to a same-repository review-only target when local Git objects are absent; this requires no fetch, checkout, or git-state mutation. Autofix still requires local objects, the head branch checked out, and the worktree rules below. Autofix and every publication action refuse such a target because publication authority is bound to the repository of the current checkout.

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

Use `printf '%s'` or an equivalent exact-byte pipeline and `sha256sum` (or an equivalent command that hashes the exact byte stream) to compute every digest. **Never estimate or invent a digest value**: a digest you did not actually compute makes the resume check meaningless, and an unstable value raises false "target changed" alarms on a target that never moved.

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
- For any destination under `external_sites` that has no configured language, **stop and ask before drafting content for that destination** rather than guessing. Review-only never posts. It never mutates providers. Exact PR `autofix` permits only `REPLY_EXCEPTION` (defined below); all other provider, external, and review-service mutations remain forbidden.
- This profile **never governs source code**, code comments, repository documentation, or commit messages. Those follow project instructions.

### Sol adversarial consistency check (AC-ADVERSARIAL, CL-D29)

Treat the exact pull-request body, the current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable assertions in this Skill as **claims to verify, not assumed context**. Semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including claims expressed with examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, or `exactly`; do not search keywords without understanding the claim.

Attempt falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence. When a named authoritative record is absent, that absence is not itself a finding; report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable. A finding requires either an actual cited counterexample that disproves the claim or a verdict-material claim that cannot be verified because required evidence is unavailable. Never invent a counterexample. No counterexample is neither a finding nor proof that the claim is correct.

Limit authoritative comments consistently with CL-D9: accept only comments by a non-bot author with `author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`, and do not revive superseded comments from #3. Report the claim, evidence searched, and the cited counterexample or unavailable evidence.

### Gate verdicts (CL-D1, PR review-only baseline)

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
- the scope boundary, so the child does not redesign approved decisions;
- the acceptance criteria the target must satisfy, so that every finding can be traced to one;
- on a gate re-invocation, every finding from that gate's earlier rounds, plus the dispositioned findings of any gate that already passed, each with its disposition and rationale.

#### Sol adversarial payload (AC-ADVERSARIAL-payload-pr, CL-D29)

Because `inheritSkills: false`, every initial Sol invocation and every Sol re-invocation must include this complete procedure in its payload: treat the exact pull-request body, current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable Skill assertions as claims to verify rather than context; semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, and `exactly` (not keyword-only); attempt falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence; when a named authoritative record is absent, treat that absence as not itself a finding and report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable; require an actual cited counterexample disproving the claim or report a verdict-material claim as unverifiable when required evidence is unavailable; never invent a counterexample; treat no counterexample as neither a finding nor proof; restrict authoritative comments to non-bot `OWNER`, `MEMBER`, or `COLLABORATOR` authors under CL-D9 and do not revive superseded #3 comments. The payload must also require the claim, searched evidence, and cited counterexample or unavailable evidence in each finding.

A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is **settled**, and the payload must say so: re-raising one requires new evidence, not a restatement. A finding that traces to no acceptance criterion is an out-of-scope improvement rather than a blocker, and must be labelled that way instead of returning `FIX BEFORE MERGE`.

Without this the loop cannot terminate. Reviewers run with fresh context and `inheritSkills: false`, so a disposition the parent recorded is invisible to the next round, and any finding not literally fixed returns indefinitely.

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

For each finding record the complete stable source identity when available: source kind, source ID, source URL, author identity and author type, body digest, created and updated timestamps, review-commit association, path and line association, observed public head, plus severity, the fingerprint it was raised against, evidence, impact, smallest correction, semantic fingerprint, disposition, rationale, corrective change when the disposition is `fixed`, validation evidence, and reply/status URL once published. In PR review-only, the proposed correction and reply are drafts outside the repository and no fixed disposition claims publication. In exact PR `autofix`, `fixed` requires Luna's published correction commit and responsible-gate confirmation against the resulting public head; confirmed source-finding replies may then be posted by the parent.

Judge findings individually. A reviewer score, severity label, or provider recommendation is never by itself a decision to change code. In review-only, record the rationale and draft each unfixed reply without posting it. In exact autofix, unconfirmed, unverifiable, or owner-decision findings receive no reply; only the bounded confirmed source-finding reply action is authorized.

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

For PR review-only, long-lived contract, waiver, and risk decisions belong on the pull request in the configured language; draft them outside the repository and hand them to the operator to post. For exact PR `autofix`, an owner decision or owner action terminates the run at `WAITING_FOR_OWNER(reason=owner_decision_required)` with no draft-post, retry, or resume action. While either mode is pending that boundary, the state is `WAITING_FOR_OWNER`.

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

The two pre-implementation classes are separated by what the test does, not by where its inputs come from. A test that **inspects an artifact's content or structure** — reading a file and checking for required or forbidden text, parsing frontmatter — is compile/contract RED. A test that **executes the thing being specified and observes what it does** is behavioural RED, and it stays behavioural when the thing it executes lives in this repository. **Assertion polarity is irrelevant**: `doesNotMatch` against a Markdown file is no more behavioural than `match` against one.

## Mode dispatch (CL-D19)

After CL-D6 mode parsing succeeds and the shared preflight, target, evidence, language, gate, disposition, decision, and test-provenance rules above are available, load the authoritative continuation for the parsed mode:

- review-only mode: read `references/review-only.md`;
- exact CL-D30 `autofix` mode: read `references/autofix.md`.

Read exactly one mode reference after mode parsing. Never read both. Follow the selected reference together with this shared contract; no instruction from the unselected mode applies.

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

Outside the CL-D31 candidate-publication phase, recompute `issue_spec` before declaring readiness; if it changed since a gate passed, that gate is stale and must run again. During CL-D31, gates are bound to the base `issue_spec` and exact frozen candidate; the separately computed snapshot-C final `issue_spec` may establish readiness without duplicate gates only through the byte/content-identity proof below.

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
- For any destination under `external_sites` that has no configured language, **stop and ask before drafting content for that destination** rather than guessing. The trigger is drafting, not posting: the CL-D31 exception only permits its exact GitHub Issue actions; external destinations without a configured language still stop before drafting.
- This profile **never governs source code**, code comments, repository documentation, or commit messages. Those follow project instructions.

Quote source text verbatim when quoting is needed.

## Mutation boundary (CL-D15, CL-D28, CL-D31)

The default remains review-and-draft only. Before candidate construction and outside the candidate-publication phase:

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not post, edit, or close anything on GitHub;
- do not mutate a provider-side review service or any external service.

Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**. The only exception is the exact CL-D31 workflow below. It does not add an executable controller or extension and never grants authority to PR commands, other aliases, foreign repositories, standalone workers, or unlisted actions.

## Gate loop (AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The order is fixed and sequential for legacy review, and the CL-D31 candidate path is a bounded extension:

```text
specification → sol-reviewer gate → disposition/revision → Sol MERGE → terra-oracle gate → disposition/revision → Terra MERGE
```

Before candidate construction, legacy review-and-draft status/resume remains available. Once CL-D31 candidate construction begins, the candidate phase is non-resumable and the exact preview/publication rules in the CL-D31 section apply.

`sol-reviewer` owns requirements, contracts, scope, acceptance, feasibility, and the bounded adversarial check below. `terra-oracle` then checks the revised specification against inherited decisions for contradiction and drift. **Never start the Terra gate before the Sol gate returns `MERGE`.**

### Sol adversarial consistency check (AC-ADVERSARIAL, CL-D29)

Treat the exact issue body, the current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable assertions in this Skill as **claims to verify, not assumed context**. Semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including claims expressed with examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, or `exactly`; do not search keywords without understanding the claim.

Attempt falsification against authoritative repository files, including `CONTRACT.md`, implementation and tests, and available Git/GitHub evidence. A finding requires either an actual cited counterexample that disproves the claim or a verdict-material claim that cannot be verified because required evidence is unavailable. Never invent a counterexample. No counterexample is neither a finding nor proof that the claim is correct.

Limit authoritative comments consistently with CL-D9: accept only comments by a non-bot author with `author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`, and do not revive superseded comments from #3. Report the claim, evidence searched, and the cited counterexample or unavailable evidence.

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

#### Sol adversarial payload (AC-ADVERSARIAL-payload-issue, CL-D29)

Because `inheritSkills: false`, every initial Sol invocation and every Sol re-invocation must include this complete procedure in its payload: treat the exact issue body, current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable Skill assertions as claims to verify rather than context; semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, and `exactly` (not keyword-only); attempt falsification against authoritative `CONTRACT.md`, implementation, tests, and available Git/GitHub evidence; require an actual cited counterexample disproving the claim or report a verdict-material claim as unverifiable when required evidence is unavailable; never invent a counterexample; treat no counterexample as neither a finding nor proof; restrict authoritative comments to non-bot `OWNER`, `MEMBER`, or `COLLABORATOR` authors under CL-D9 and do not revive superseded #3 comments. The payload must also require the claim, searched evidence, and cited counterexample or unavailable evidence in each finding.

A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is **settled**, and the payload must say so: re-raising one requires new evidence, not a restatement. A finding that traces to no acceptance criterion is an out-of-scope improvement rather than a blocker, and must be labelled that way instead of returning `FIX BEFORE MERGE`.

Without this the loop cannot terminate. Reviewers run with fresh context and `inheritSkills: false`, so a disposition the parent recorded is invisible to the next round, and any finding not literally fixed returns indefinitely.

### Round accounting (CL-D11, CL-D12)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- If a Terra finding forces a change to something Sol already approved, the Sol gate must run again and consumes one of its own rounds.
- At the limit, ask the owner whether to grant more rounds. Before candidate construction and outside the candidate-publication phase, report `ROUND_LIMIT_REACHED` through the legacy status path. During CL-D31, pause only as a live same-session owner question without emitting resumable state; an individually granted extension remains bound to the same frozen candidate and session. A decline, session end, later command, or ungranted limit terminates the phase and discards candidate authority.

Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block so the owner can carry them forward. **Do not create a state file** to work around this; persistent workflow state is a later stage.

## Owner-gated Issue candidate publication (CL-D31)

This legacy Skill/prompt package remains prose orchestration with no executable controller or extension. The bounded authority is one optional body PATCH and one exact ledger POST. The fixed review order is Sol-before-Terra. After both gates return MERGE, the parent shows an exact same-session owner preview; readiness retains the disclosed observational residual risk.

This section is the authoritative implementation of published Issue #13 and applies identically to the two equivalent entrypoints `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>`. The legacy Skill/prompt package remains the orchestrating runtime; this is a Skill/prompt-only orchestration contract: it is normative prose plus test-local reference fixtures, not an executable controller. A foreign-repository Issue remains review-and-draft-only and never receives an exact preview or mutation authority.

### Candidate phase and immutable bundle

The candidate-publication phase begins when the complete candidate bundle and its candidate identity are constructed, before the first counted Sol invocation. Construct one repository-external `tidd-issue-candidate-v1` bundle for one complete current Issue snapshot. The bundle contains the checkout and target repository identity, Issue number and URL, base `issue_spec`, canonical base and proposed body bytes/digests, complete unified body diff bytes/digest, every authoritative comment identity and body, exactly one complete English finding/disposition ledger comment, separate complete AC-DISPOSITION records, complete DEC-I13 owner decisions, and the complete authoritative-comment identity set. Every finding record carries source gate, severity, reviewed base/candidate identity, evidence, impact, exactly one disposition, rationale, revised passage when fixed, validation evidence, and source/reply/status URL or an explicit snapshot-C assignment.

Freeze that complete bundle as one immutable same-session object; this is the frozen complete bundle used by every gate and preview. The exact canonical UTF-8/LF diff bytes, including labels, context, and hunks, are frozen even though the diff is not in the candidate-v1 identity stream. Every gate launch identity maps to this object; both gates and the owner preview reuse its exact bytes without regeneration. A diff-only substitution that leaves candidate-v1 unchanged invalidates the affected evidence and restarts at Sol. The bundle is never restored from pasted status or another session.

Candidate identity is the lowercase hexadecimal SHA-256 digest over the complete `tidd-issue-candidate-v1` byte stream, from the domain header through the final newline of `ledger.comment`. Candidate-v1 uses the exact ASCII domain header `tidd-issue-candidate-v1\n` and this exact fixed ordered field sequence: `repository`, `issue.number`, `issue.url`, `base.issue_spec.sha256`, `base.body`, `base.comments.count`, then for each authoritative comment in ascending numeric comment-ID order `base.comments.<index>.id`, `base.comments.<index>.updated_at`, `base.comments.<index>.body`, followed by `proposed.body`, and `ledger.comment`. Comment indices are zero-based, contiguous, and numeric; the count is the complete count. Every field is `<field-name> <decimal-utf8-byte-length>\n<raw-bytes>\n`; names are exactly ASCII `[a-z0-9._-]+`, decimal lengths are ASCII digits with no leading zero except `0`, and byte lengths count normalized raw UTF-8 payload bytes. Text normalizes CRLF and CR to LF before encoding. `repository` is the GitHub API `repository.full_name` ASCII; Issue number, comment count, index, and IDs are leading-zero-free ASCII decimals; URL is exactly `https://github.com/<repository>/issues/<issue.number>`; timestamps are strict UTC `YYYY-MM-DDTHH:mm:ssZ`; and SHA-256 values are lowercase 64-hex ASCII. The derived display diff never replaces either body field. Any schema, field, order, framing, scalar, or canonicalization change requires a new serialization version and exact domain header even when sample bytes happen to match.

### Checkout identity and complete stable snapshots

Resolve the current checkout repository without changing Git state. If the current branch has one configured upstream remote other than `.`, select it; otherwise select every configured remote. For each selected remote independently obtain the complete effective fetch and push sets using Git's own `git remote get-url --all <remote>` and `git remote get-url --push --all <remote>` behavior. Never inspect only the first URL, synthesize push from fetch, or infer either set from raw configuration. Effective `insteadOf`, `pushInsteadOf`, explicit push URLs, and fallback semantics must be included.

Continue only when every selected remote has non-empty effective fetch and push sets. Recognized inputs are exactly `https://github.com/<owner>/<repo>[.git]`, `ssh://git@github.com/<owner>/<repo>[.git]`, and `git@github.com:<owner>/<repo>[.git]`, with no query or fragment. Every parsed identity must resolve through the GitHub API to one canonical `repository.full_name`. Missing, local-only, malformed, non-GitHub, ambiguous, conflicting fetch/push, fork/upstream, moved, or multiple-repository identity fails closed. The resolved checkout repository must exactly equal the candidate repository and target API repository. Re-resolve before preview, snapshot A, PATCH, and POST. A foreign target is always review-and-draft-only.

Every initial candidate snapshot and publication snapshot A, B, and C uses complete terminal pagination and the same fixed bracket `R0 → C1 → R1 → C2 → R2 → C3`. Each complete paginated comment capture follows every page until explicit terminal pagination; an empty terminal page/set is valid only when the provider-reported total is zero; reject page failure, missing/repeated cursor or page, duplicate IDs, truncation, missing terminal indication, ordering ambiguity, and provider total mismatch. Retain all comments and filter CL-D9 authoritative comments only after complete retrieval; retain the complete authoritative subset for evidence. Accept only identical R identity/body bytes and identical complete ordered C tuples (id, updatedAt, canonical body, author type, author_association), including the complete all-comment component set before filtering. Compute each accepted snapshot's `issue_spec` specifically from the canonical body at R2 followed by the authoritative subset from final C3. This is a fixed observational stability check, not a provider lock and makes no claim about unobserved interleavings. Do not retry inside one publication attempt. Do not compensate, overwrite, delete, or resume after any failure; the publication attempt is no-resume and no-compensation; no compensation is ever attempted.

### Gate correlation and sequential review

At every fresh run generate one unpredictable fresh 128-bit run nonce as exactly 32 lowercase hexadecimal characters. Keep a leading-zero-free physical-attempt sequence beginning at 1. Before every physical Sol or Terra launch—including provider/startup/tool failures and the one allowed missing/unparsable-verdict retry—allocate a new `tidd-issue-gate-v1:<run_nonce>:<attempt_seq>` identity. A retry keeps its counted round but receives a new physical identity. Each request and accepted result must echo and match separate tuple fields for target, base `issue_spec`, candidate identity, gate, and proposed counted round, together with nonce, attempt sequence, and invocation identity. The parent in-session map binds the exact invocation identity to the frozen bundle object; there is no additional or undefined echoed frozen-bundle identity field. Consume each identity exactly once and reject missing, malformed, duplicated, reused, stale, cross-run, wrong-attempt, or mismatched results.

The order is fixed: construct/freeze the bundle, Sol reviews the complete unchanged object, then after Sol `MERGE` Terra reviews that same object. A candidate-changing finding or Terra correction creates a new candidate identity and restarts at Sol. Only matching Sol and Terra `MERGE` results for one unchanged frozen object authorize the preview. Existing per-gate three-round accounting, verdict vocabulary, finding dispositions, owner decisions, adversarial Sol duty, and acceptance criteria remain in force. A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is settled and cannot be reopened without new evidence.

### Exact same-session owner preview and approval

After both gates merge the same frozen object, stop at `WAITING_FOR_OWNER` and show one exact-preview: show exactly one unique pending preview: target/base `issue_spec`, candidate identity, all body/ledger/diff digests, the complete untruncated unified diff, full ledger text, actions in order, no-retry/partial-failure behavior, and the exact candidate object authorized. Ask one binary question. The current session operator may answer `approve` or `承認`; the answer is internally bound to the displayed target and frozen object, so no digest retyping is required. An explicit decline or cancel clears authority and ends `ABORTED`; any other response grants no authority and remains waiting only while the exact interactive preview is current.

Candidate regeneration, bundle-byte substitution, session end, later command, observed authoritative input change, resolver movement, identity movement, provider/capture failure, uncertainty, or any terminal outcome expires the preview and approval. During the candidate phase do not emit or accept a resumable `tidd-status`. A plain audit summary must mark candidate, approval, and gate evidence unusable and name a fresh `/tidd-issue <ref>` or `/skill:closed-loop-issue <ref>` command. Pasting it never restores authority. Legacy Issue status/resume remains available before candidate construction and outside the phase; PR status/resume and all PR behavior remain unchanged.

### One bounded no-retry publication attempt

Before any publication attempt, including a no-body-change attempt that omits PATCH, re-resolve identity and capture stable snapshot A. Require A to match repository, Issue number/URL, base `issue_spec`, canonical base body, authoritative count, and every ordered authoritative comment identity/body. Any observed stable mismatch before the first mutation ends `WAITING_FOR_OWNER` and requires a fresh equivalent run. Provider, tool, capture, malformed identity, or resolver failure before mutation ends `BLOCKED` and requires a fresh run. When the body diff is empty, snapshot B is still required before the first POST.

With exact approval and matching A, consume approval at the first mutation. If the body diff is non-empty, perform at most one approved body PATCH. Refetch stable snapshot B and require the expected body and no unexpected authoritative input. Re-resolve immediately before one exact ledger POST and then refetch stable snapshot C. Do not edit/delete comments, close/reopen, labels, milestones, linked issues, review services, or any other provider state. Never retry, compensate, delete, overwrite, resume, or start a second attempt.

PATCH and POST are not atomic. After the first mutation, any HTTP/provider/tool/capture/identity failure, timeout, uncertain outcome, response mismatch, unexpected authoritative input, unstable snapshot, or postcondition mismatch terminates the attempt at `WAITING_FOR_OWNER` with non-reusable authority. Report observed partial state and require a fresh run. A provider outcome that is unknown is never treated as success.

### Snapshot-C proof and external invalidation

Readiness requires the final published issue_spec and snapshot C to observe the exact approved proposed body, exactly one newly created ledger comment with exact approved bytes and recorded transport identity, CL-D9 eligibility as non-bot `OWNER`, `MEMBER`, or `COLLABORATOR`, no unexpected authoritative input across the fixed bracket, and complete semantic equality with the reviewed bundle. Record C's final published `issue_spec` as the observational readiness linearization point and allow `IMPLEMENTATION_READY` without duplicate Sol/Terra gates only for this byte/content-identical candidate. This proof is limited to observed R2/C3 state and cannot exclude later races, a post-R2/C3 edit, or an overwritten interleaving.

A later observed authoritative body edit or qualifying comment addition/edit/deletion/reclassification invalidates the candidate and readiness and requires a fresh equivalent run. Bot and other advisory comments remain outside `issue_spec`. Author metadata establishes eligibility, not human agency. The only publication actions are the optional current-repository body PATCH and one exact ledger POST; all other mutation remains forbidden.

### Issue 13 validation and fixture boundary

Artifact assertions inspect the shipped Skill, prompt, README, contract, and package output. Reference fixtures cover candidate framing/scalars/Unicode/CRLF/delimiters/version boundaries/diff substitution; effective fetch/push resolver sets and canonical identities; complete pagination and every snapshot adjacency/failure class; nonce, attempts, result rejection, rounds/order/restarts; complete finding/decision records; preview/decline/non-affirmative/expiry; candidate-phase status rules and legacy resume preservation; snapshots A/B/C; bounded mutation failures and no retry; final CL-D9 membership/readiness and later invalidation. Every test-local fixture is labeled `fixture:` and pins intended semantics only; it cannot prove LLM execution, provider locking, or orchestration runtime behavior.

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

For each finding record the source gate, severity, the `issue_spec` it was raised against, candidate identity, evidence, impact, exactly one disposition, rationale, revised passage when the disposition is `fixed`, validation evidence that the revision resolves it, and the reply/status URL or explicit snapshot-C assignment. Before candidate construction and outside CL-D31, an operator-post URL may remain pending; during CL-D31 the frozen English ledger owns the complete record and snapshot-C transport assignment. Judge findings individually; a severity label is never by itself a decision to change the specification. Record the rationale for anything intentionally left unchanged.

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

Long-lived contract, waiver, and risk decisions belong on the issue in the configured issue language. Before candidate construction and outside CL-D31, draft them and hand them to the operator to post. During CL-D31, the frozen English ledger owns the complete decision record and snapshot-C URL assignment; the operator action is only the exact same-session preview answer.

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

Outside CL-D31, declare `IMPLEMENTATION_READY` only when both gates returned `MERGE` against the current `issue_spec`, every finding has a disposition, no owner decision is pending, and **the approved specification is the published specification**. During CL-D31, the gates instead match the base `issue_spec` and exact frozen candidate; readiness requires every finding dispositioned, no decision pending, and the complete snapshot-C proof of the final published `issue_spec`, exact body, and exact new ledger comment, without duplicate gates.

A run that drafts a revision before CL-D31 candidate construction ends at `WAITING_FOR_OWNER`; the legacy review-only gate approved text the Issue does not yet contain. During CL-D31, only the post-gate/pre-attempt `WAITING_FOR_OWNER` state carries the active exact same-session preview and may proceed through the bounded attempt. A pre-mutation mismatch or any post-first-mutation failure also reports `WAITING_FOR_OWNER`, but it is audit-only with expired, non-reusable authority and a fresh equivalent command as the only next action. After any operator-posted revision outside that attempt, recompute `issue_spec` and rerun both gates against the exact authoritative text.

Before candidate construction and otherwise outside the CL-D31 candidate-publication phase, whenever the run stops without reaching readiness, emit the legacy resumable block below. Its `publication_grant: not-applicable` field describes only that legacy state.

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

During candidate construction and the entire candidate-publication phase, never emit or accept that resumable `tidd-status`. A live same-session owner-decision or round-extension question may pause and continue without resumable state while the exact frozen candidate remains active. If the phase ends at an ungranted round limit or owner-decision terminal outcome, or through interruption, session end, later command, failure, uncertainty, invalidation, provider/capture error, or completion, discard candidate, approval, and gate authority. Emit only a non-restoring audit summary naming the exact unusable candidate and the fresh `/tidd-issue <ref>` or `/skill:closed-loop-issue <ref>` command that is the single next action. A pasted audit summary never restores state.

Legacy resume means pasting the legacy status block back; revalidate the fingerprints first and refuse changed targets. Candidate phase has no resume or retry; any extra round requires a live same-session owner grant.

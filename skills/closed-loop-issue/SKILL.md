---
name: closed-loop-issue
description: Drive a GitHub issue to IMPLEMENTATION_READY through sequential read-only requirements and decision-drift gates, recording finding dispositions, owner decisions, and evidence fingerprints. Use only when the operator explicitly runs /tidd-issue or /skill:closed-loop-issue with an issue reference.
---

# Closed-loop issue readiness

Take one GitHub issue from specification to `IMPLEMENTATION_READY` by reviewing it, dispositioning every finding, revising the specification, and revalidating the current authoritative revision.

You are the orchestrator. Formal gates run as read-only subagents. This skill never merges anything and never becomes an autonomous editor.


## Shared references (Issue #24)

Before workflow-specific rules, read both common references relative to this Skill directory. The shared Sol procedure searches authoritative files of the repository under review; that absence is not itself a finding.

- `../closed-loop-shared/references/gate-contract.md`
- `../closed-loop-shared/references/records.md`

The shared files supply common Issue/PR grammar, evidence, and record taxonomy; this Issue Skill remains authoritative for Issue target rejection, agents, gates, status, publication, and CL-D31/CL-D32 behavior.

## Precondition guard (CL-D20)

This skill runs only against an explicit target supplied by the operator.

If no issue reference was supplied, stop and print usage:

```text
/tidd-issue <issue-ref>
```

Do not infer a target, do not scan for candidate issues, and do not start any gate. Report `BLOCKED` and end the run.

## Preflight (CL-D22, CL-D5)

Before the first gate, confirm the workflow-specific required agents resolve: `sol-reviewer` and `terra-oracle`. If a required agent does not resolve, stop and report `BLOCKED`, naming the missing agent and the override path. Do not begin a gate that cannot finish. A preflight failure is not a review round.

## Workflow target-kind boundary (CL-D7, CL-D8)

Resolve the reference after the shared target grammar has consumed the target reference. Reject any remaining argument before calling `gh`. **Verify that the resolved target is the expected kind**: GitHub numbers issues and pull requests in one sequence, so a number alone does not identify the kind. If the reference resolves to a pull request, stop and tell the operator to use `/tidd-pr`.

A target in **another repository** may be reviewed, but nothing may be published to it and no local work may be started for it. Publication authority is bound to the repository of the current checkout.

## Evidence fingerprints (CL-D9)

Record the identity of what you reviewed, so later evidence is invalidated only where it no longer applies.

- `issue_spec` — `sha256` over canonical UTF-8 bytes consisting of the issue body record followed by each authoritative comment rendered as `<id>:<updatedAt>:<body>`, ordered by comment id ascending, with records joined by one LF (`0x0a`) and no trailing separator. Normalize CRLF and CR in text fields to LF before encoding. Do not let shell locale, Git configuration, or platform newline conversion alter the bytes.

Use `LC_ALL=C`, `printf '%s'`, explicit UTF-8 input, and `sha256sum` (or an equivalent command that hashes the exact byte stream) to compute the digest. **Never estimate or invent a digest value**: a digest you did not actually compute makes the resume check meaningless, and an unstable value raises false "target changed" alarms on a target that never moved.

An **authoritative comment** is one whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` and whose author **is not a bot**. Every other comment is advisory context and stays out of the fingerprint.

Outside the CL-D31 candidate-publication phase, recompute `issue_spec` before declaring readiness; if it changed since a gate passed, that gate is stale and must run again. During CL-D31, gates are bound to the base `issue_spec` and exact frozen candidate; the separately computed snapshot-C final `issue_spec` may establish readiness without duplicate gates only through the byte/content-identity proof below.

## Mutation boundary (CL-D15, CL-D28, CL-D31)

The default remains review-and-draft only. Before candidate construction and outside the candidate-publication phase:

- do not edit any file in the repository, tracked or untracked;
- do not change git state;
- do not post, edit, or close anything on GitHub;
- do not mutate a provider-side review service or any external service.

Working notes, the disposition ledger, and drafts belong in a temporary directory **outside the repository**. The only exception is the exact CL-D31 workflow below. It does not add an executable controller or extension and never grants authority to PR commands, other aliases, foreign repositories, standalone workers, or unlisted actions.

## Issue-specific record and gate obligations

The Issue workflow retains these obligations outside the shared references:

- `terra-oracle` has no verdict contract of its own; the parent requires the shared verdict vocabulary in its invocation payload.
- External review services, external static-analysis sites, and pull-request checks **are not part of issue readiness** (AC-ISSUE-NO-EXTERNAL).
- Issue finding records retain the `issue_spec` raised-against field, candidate identity, revised passage, validation evidence, and explicit snapshot-C assignment.

### Issue finding record fields (AC-DISPOSITION)

For each finding record the source gate, severity, the `issue_spec` it was raised against, candidate identity, evidence, impact, exactly one disposition, rationale, revised passage when the disposition is `fixed`, validation evidence that the revision resolves it, and the reply/status URL or explicit snapshot-C assignment.
- Issue owner decisions retain the CL-D31/CL-D32 language, publication transport, and owner-action boundaries. The frozen English ledger owns the complete decision record during CL-D31.
- Issue policy precedence is project instructions, then authoritative Issue requirements that do not weaken them, then the package default. A recorded owner exception is a narrow override of a named rule and must state its scope, rationale, and invalidation conditions.

### Issue owner-decision scope (AC-DECISION)

Pause for the owner on public contracts and APIs, architecture, scope, compatibility and risk trade-offs, policy exceptions, and ADR acceptance. Routine details that an approved contract already settles are yours to decide. While an owner decision or owner action is pending, the state is `WAITING_FOR_OWNER`.

### Issue AC-TDD quality gate (AC-TDD)

An issue is not ready until it states its acceptance contract and validation plan. Apply the risk-based test-first default when reviewing that plan.

### Issue malformed-verdict boundary (CL-D1, CL-D32)

Only under ordinary CL-D31 rules, a missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`. Under CL-D32, tool, provider, startup, capture, malformed, missing, or uncertain outcomes still allocate physical identities under the existing correlation rules, but expire the combined approval and any dormant or activated grant; they cannot use the ordinary missing-or-unparsable retry.

## Gate loop (AC-GATES, CL-D1, CL-D2, CL-D11, CL-D12)

The order is fixed and sequential for legacy review, and the CL-D31 candidate path is a bounded extension:

```text
specification → sol-reviewer gate → disposition/revision → Sol MERGE → terra-oracle gate → disposition/revision → Terra MERGE
```

Before candidate construction, legacy review-and-draft status/resume remains available. Once CL-D31 candidate construction begins, the candidate phase is non-resumable and the exact preview/publication rules in the CL-D31 section apply.

`sol-reviewer` owns requirements, contracts, scope, acceptance, feasibility, and the shared adversarial falsification procedure. `terra-oracle` then checks the revised specification against inherited decisions for contradiction and drift. **Never start the Terra gate before the Sol gate returns `MERGE`.**

## Owner-gated Issue candidate publication (CL-D31)

This legacy Skill/prompt package remains prose orchestration with no executable controller or extension. The bounded authority is one optional body PATCH and one exact ledger POST. The fixed review order is Sol-before-Terra. In the ordinary CL-D31 route only, after both gates return MERGE the parent shows an exact same-session owner preview; readiness retains the disclosed observational residual risk. CL-D32 is the sole narrow pre-rereview combined-preview exception and grants no mutation before the mandatory unchanged Sol then Terra sequence.

This section is the authoritative implementation of published Issue #13 and applies identically to the two equivalent entrypoints `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>`. The legacy Skill/prompt package remains the orchestrating runtime; this is a Skill/prompt-only orchestration contract: it is normative prose, not an executable controller. A foreign-repository Issue remains review-and-draft-only and never receives an exact preview or mutation authority.

### Combined scope-freeze decision transaction (CL-D32)

CL-D32 is a narrow entry path into the CL-D31 candidate-publication phase; it does not replace CL-D31 or add executable orchestration. The ordinary CL-D31 route remains: construct one complete candidate, Sol `MERGE`, Terra `MERGE`, then show the exact post-gate preview. The combined route is eligible only when an independent pre-question antecedent is true: the target is a current-repository Issue, target identity is verified, checkout guards pass, and the existing resolver guards pass. Foreign-repository Issues are review-and-draft-only and never receive this preview or publication authority.

Inside that antecedent, and only there, the five necessary-and-sufficient decision conditions are: (1) Sol raises exactly one pending owner decision; (2) it is exactly one readiness-blocking scope-freeze decision; (3) no other owner decision, waiver, security/risk choice, architecture choice, API choice, compatibility choice, or policy exception is pending; (4) the parent can construct one complete recommended option with complete trade-offs without guessing any owner-controlled value; and (5) the owner is shown exactly one complete candidate, the recommended candidate, with no alternative candidate. Any failed antecedent retains its existing fail-closed or foreign review-only behavior; any failed condition retains the legacy owner-decision/operator-post path. No additional decision class is eligible.

After those checks, the parent constructs and freezes one complete decision-containing candidate before asking the owner. The preview shows the target and base `issue_spec`, candidate identity, complete proposed body, unified diff, complete ledger, complete nine-field target-specific readiness-blocking scope-freeze AC-DECISION record (for example `DEC-56-SCOPE-FREEZE-001`), exact actions, exact affirmative response bytes, and every invalidation and no-retry rule. This target-specific record is distinct from the repository contract decision `DEC-I15-ROUND-BUDGET-001`, which selects dormant-round semantics and is not transported as the per-target decision. The complete frozen decision has exactly the canonical fields `Decision ID`, `Kind`, `Target and revision`, `Question`, `Options and trade-offs`, `Recommendation`, `Owner choice`, `Rationale`, and `Validity and invalidation conditions`, each once. Its `Owner choice` field is exactly: `Option B: adopt the exact recommended scope without guessing an owner value. Conditionally selected by the exact affirmative response bound to this displayed candidate; no owner choice exists unless that response is observed.`

The displayed combined question accepts one exact affirmative response byte sequence bound to this displayed target, run, session, and candidate. That response changes only logical state: it makes the conditional owner choice true and activates the conditional grant as applicable; it does not rewrite candidate, body, diff, ledger, decision, or any other frozen bytes. A decline, non-affirmative response, different option, changed case/whitespace, or paraphrase leaves no owner choice, discards the candidate and grant, and performs no mutation. A different option requires a newly constructed decision record, candidate, and preview. Never publish the scope-freeze decision as a standalone comment; it is authoritative exactly once inside the final ledger POST proved by Snapshot C.

The combined response carries a dormant grant for at most one additional counted Sol round. It activates if and only if the decision arose on the last already-authorized counted Sol round and no counted round remains for the mandatory post-decision Sol re-review. When an already-authorized round remains, the grant stays dormant, unused, and unconsumed. An activated grant is bound to the same repository, Issue, base `issue_spec`, run nonce, session, candidate identity, complete frozen bytes/digests, decision, and purpose `post-decision-sol-rereview`; it authorizes only that next Sol re-review, never Terra, publication, retry, correction, transfer, replay, later command, or further extension. Physical-attempt allocation and consumption rules remain unchanged.

The exact affirmative response never bypasses review. Sol must re-review the unchanged candidate containing the decision, and Terra starts only after Sol returns `MERGE` and reviews that identical candidate, body, diff, and ledger. Only then do the existing Snapshot A, optional body PATCH, Snapshot B, one ledger POST, and Snapshot C proof run. `IMPLEMENTATION_READY` is emitted only after all existing Snapshot-C readiness predicates pass. Before both gates merge, mutations are forbidden; the only authorized actions after matching proof remain the optional body PATCH and one ledger POST.

Candidate regeneration, any candidate/body/diff/ledger byte change, a candidate-changing Sol or Terra finding, a different or new owner decision, authoritative input change, target/resolver/checkout/identity movement, base-spec movement, session end, later command, tool/provider/capture failure, malformed or missing result, uncertainty, non-`MERGE`, `FIX BEFORE MERGE`, `NEEDS DECISION`, any terminal outcome, cross-run or cross-target replay, transfer, retry, or further extension independently expires the combined approval and grant. Expiry requires a new exact candidate and owner response and causes no retry, transfer, Terra launch, further extension, compensation, standalone decision post, or mutation. The path never grants implementation-start authority, repository or Git mutation, commit, push, PR creation, merge, provider review-service mutation, labels, milestones, close, or any other external action. Both `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>` remain equivalent; PR behavior and its separate autofix boundary are unchanged.

### Candidate phase and immutable bundle

The candidate-publication phase ordinarily begins when the complete candidate bundle and its candidate identity are constructed, before the first counted Sol invocation. For CL-D32, the Sol result that raises combined-route eligibility is legacy/pre-candidate review; constructing the conditional decision bundle and exact candidate enters the candidate phase, and that earlier result is not a review of the new candidate. Construct one repository-external `tidd-issue-candidate-v1` bundle for one complete current Issue snapshot. The bundle contains the checkout and target repository identity, Issue number and URL, base `issue_spec`, canonical base and proposed body bytes/digests, complete unified body diff bytes/digest, every authoritative comment identity and body, exactly one complete English finding/disposition ledger comment, separate complete AC-DISPOSITION records, all applicable complete AC-DECISION records—including the target-specific conditional scope-freeze decision under CL-D32—and the complete authoritative-comment identity set. Existing DEC-I13 owner-decision semantics remain unchanged where applicable. Every finding record carries source gate, severity, reviewed base/candidate identity, evidence, impact, exactly one disposition, rationale, revised passage when fixed, validation evidence, and source/reply/status URL or an explicit snapshot-C assignment.

Freeze that complete bundle as one immutable same-session object; this is the frozen complete bundle used by every gate and preview. The exact canonical UTF-8/LF diff bytes, including labels, context, and hunks, are frozen even though the diff is not in the candidate-v1 identity stream. Every gate launch identity maps to this object; both gates and the owner preview reuse its exact bytes without regeneration. A diff-only substitution that leaves candidate-v1 unchanged invalidates the affected evidence and restarts at Sol. The bundle is never restored from pasted status or another session.

Candidate identity is the lowercase hexadecimal SHA-256 digest over the complete `tidd-issue-candidate-v1` byte stream, from the domain header through the final newline of `ledger.comment`. Candidate-v1 uses the exact ASCII domain header `tidd-issue-candidate-v1\n` and this exact fixed ordered field sequence: `repository`, `issue.number`, `issue.url`, `base.issue_spec.sha256`, `base.body`, `base.comments.count`, then for each authoritative comment in ascending numeric comment-ID order `base.comments.<index>.id`, `base.comments.<index>.updated_at`, `base.comments.<index>.body`, followed by `proposed.body`, and `ledger.comment`. Comment indices are zero-based, contiguous, and numeric; the count is the complete count. Every field is `<field-name> <decimal-utf8-byte-length>\n<raw-bytes>\n`; names are exactly ASCII `[a-z0-9._-]+`, decimal lengths are ASCII digits with no leading zero except `0`, and byte lengths count normalized raw UTF-8 payload bytes. Text normalizes CRLF and CR to LF before encoding. `repository` is the GitHub API `repository.full_name` ASCII; Issue number, comment count, index, and IDs are leading-zero-free ASCII decimals; URL is exactly `https://github.com/<repository>/issues/<issue.number>`; timestamps are strict UTC `YYYY-MM-DDTHH:mm:ssZ`; and SHA-256 values are lowercase 64-hex ASCII. The derived display diff never replaces either body field. Any schema, field, order, framing, scalar, or canonicalization change requires a new serialization version and exact domain header even when sample bytes happen to match.

### Checkout identity and complete stable snapshots

Resolve the current checkout repository without changing Git state. If the current branch has one configured upstream remote other than `.`, select it; otherwise select every configured remote. For each selected remote independently obtain the complete effective fetch and push sets using Git's own `git remote get-url --all <remote>` and `git remote get-url --push --all <remote>` behavior. Never inspect only the first URL, synthesize push from fetch, or infer either set from raw configuration. Effective `insteadOf`, `pushInsteadOf`, explicit push URLs, and fallback semantics must be included.

Continue only when every selected remote has non-empty effective fetch and push sets. Recognized inputs are exactly `https://github.com/<owner>/<repo>[.git]`, `ssh://git@github.com/<owner>/<repo>[.git]`, and `git@github.com:<owner>/<repo>[.git]`, with no query or fragment. Every parsed identity must resolve through the GitHub API to one canonical `repository.full_name`. Missing, local-only, malformed, non-GitHub, ambiguous, conflicting fetch/push, fork/upstream, moved, or multiple-repository identity fails closed. The resolved checkout repository must exactly equal the candidate repository and target API repository. Re-resolve before preview, snapshot A, PATCH, and POST. A foreign target is always review-and-draft-only.

Every initial candidate snapshot and publication snapshot A, B, and C uses complete terminal pagination and the same fixed bracket `R0 → C1 → R1 → C2 → R2 → C3`. Each complete paginated comment capture follows every page until explicit terminal pagination; an empty terminal page/set is valid only when the provider-reported total is zero; reject page failure, missing/repeated cursor or page, duplicate IDs, truncation, missing terminal indication, ordering ambiguity, and provider total mismatch. Retain all comments and filter CL-D9 authoritative comments only after complete retrieval; retain the complete authoritative subset for evidence. Accept only identical R identity/body bytes and identical complete ordered C tuples (id, updatedAt, canonical body, author type, author_association), including the complete all-comment component set before filtering. Compute each accepted snapshot's `issue_spec` specifically from the canonical body at R2 followed by the authoritative subset from final C3. This is a fixed observational stability check, not a provider lock and makes no claim about unobserved interleavings. Do not retry inside one publication attempt. Do not compensate, overwrite, delete, or resume after any failure; the publication attempt is no-resume and no-compensation; no compensation is ever attempted.

### Gate correlation and sequential review

At every fresh run generate one unpredictable fresh 128-bit run nonce as exactly 32 lowercase hexadecimal characters. Keep a leading-zero-free physical-attempt sequence beginning at 1. The pre-candidate Sol result that first raises CL-D32 eligibility remains governed by the legacy `issue_spec` gate payload and counted-round rules; it has no complete decision-containing candidate identity and cannot satisfy the mandatory post-decision rereview. After candidate construction, before every physical Sol or Terra launch—including provider/startup/tool failures and the ordinary one allowed missing/unparsable-verdict retry—allocate a new `tidd-issue-gate-v1:<run_nonce>:<attempt_seq>` identity. A retry keeps its counted round but receives a new physical identity. Under CL-D32, tool/provider/startup/capture/malformed/uncertain outcomes still allocate the physical identity under these existing rules but expire the combined approval/grant and cannot use that ordinary retry. Each candidate-phase request and accepted result must echo and match separate tuple fields for target, base `issue_spec`, candidate identity, gate, and proposed counted round, together with nonce, attempt sequence, and invocation identity. The parent in-session map binds the exact invocation identity to the frozen bundle object; there is no additional or undefined echoed frozen-bundle identity field. Consume each identity exactly once and reject missing, malformed, duplicated, reused, stale, cross-run, wrong-attempt, or mismatched results.

The ordinary CL-D31 order is fixed: construct/freeze the bundle, Sol reviews the complete unchanged object, then after Sol `MERGE` Terra reviews that same object; only matching Sol and Terra `MERGE` results authorize the ordinary post-gate preview. CL-D32's combined pre-rereview preview is the sole exception: it grants no mutation, and mandatory unchanged Sol then Terra review follows the exact affirmative response. A candidate-changing finding or Terra correction creates a new candidate identity and restarts at Sol. Existing per-gate three-round accounting, verdict vocabulary, finding dispositions, owner decisions, adversarial Sol duty, and acceptance criteria remain in force. A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is settled and cannot be reopened without new evidence.

### Exact same-session owner preview and approval

In the ordinary CL-D31 route, after both gates merge the same frozen object, stop at `WAITING_FOR_OWNER` and show one exact-preview: show exactly one unique pending preview: target/base `issue_spec`, candidate identity, all body/ledger/diff digests, the complete untruncated unified diff, full ledger text, actions in order, no-retry/partial-failure behavior, and the exact candidate object authorized. Ask one binary question. The current session operator may answer `approve` or `承認`; the answer is internally bound to the displayed target and frozen object, so no digest retyping is required. An explicit decline or cancel clears authority and ends `ABORTED`; any other response grants no authority and remains waiting only while the exact interactive preview is current. The unchanged CL-D32 combined response is the sole pre-rereview exception and replaces this later prompt: when the candidate remains byte-identical and every downstream publication/readiness proof passes, never ask for a second approval, command, or fresh run. A downstream mismatch or failure still follows the fresh-run invalidation rules below. All A/B/C, publication, and readiness guards remain mandatory.

Candidate regeneration, bundle-byte substitution, session end, later command, observed authoritative input change, resolver movement, identity movement, provider/capture failure, uncertainty, or any terminal outcome expires the preview and approval. During the candidate phase do not emit or accept a resumable `tidd-status`. A plain audit summary must mark candidate, approval, and gate evidence unusable and name a fresh `/tidd-issue <ref>` or `/skill:closed-loop-issue <ref>` command. Pasting it never restores authority. Legacy Issue status/resume remains available before candidate construction and outside the phase; PR status/resume and all PR behavior remain unchanged.

### One bounded no-retry publication attempt

Before any publication attempt, including a no-body-change attempt that omits PATCH, re-resolve identity and capture stable snapshot A. Require A to match repository, Issue number/URL, base `issue_spec`, canonical base body, authoritative count, and every ordered authoritative comment identity/body. Any observed stable mismatch before the first mutation ends `WAITING_FOR_OWNER` and requires a fresh equivalent run. Provider, tool, capture, malformed identity, or resolver failure before mutation ends `BLOCKED` and requires a fresh run. When the body diff is empty, snapshot B is still required before the first POST.

With exact approval and matching A, consume approval at the first mutation. If the body diff is non-empty, perform at most one approved body PATCH. Refetch stable snapshot B and require the expected body and no unexpected authoritative input. Re-resolve immediately before one exact ledger POST and then refetch stable snapshot C. Do not edit/delete comments, close/reopen, labels, milestones, linked issues, review services, or any other provider state. Never retry, compensate, perform a compensating overwrite after failure, delete, resume, or start a second attempt.

PATCH and POST are not atomic. After the first mutation, any HTTP/provider/tool/capture/identity failure, timeout, uncertain outcome, response mismatch, unexpected authoritative input, unstable snapshot, or postcondition mismatch terminates the attempt at `WAITING_FOR_OWNER` with non-reusable authority. Report observed partial state and require a fresh run. A provider outcome that is unknown is never treated as success.

### Snapshot-C proof and external invalidation

Readiness requires the final published issue_spec and snapshot C to observe the exact approved proposed body, exactly one newly created ledger comment with exact approved bytes and recorded transport identity, CL-D9 eligibility as non-bot `OWNER`, `MEMBER`, or `COLLABORATOR`, no unexpected authoritative input across the fixed bracket, and complete semantic equality with the reviewed bundle. Record C's final published `issue_spec` as the observational readiness linearization point and allow `IMPLEMENTATION_READY` without duplicate Sol/Terra gates only for this byte/content-identical candidate. This proof is limited to observed R2/C3 state and cannot exclude later races, a post-R2/C3 edit, or an overwritten interleaving.

A later observed authoritative body edit or qualifying comment addition/edit/deletion/reclassification invalidates the candidate and readiness and requires a fresh equivalent run. Bot and other advisory comments remain outside `issue_spec`. Author metadata establishes eligibility, not human agency. The only publication actions are the optional current-repository body PATCH and one exact ledger POST; all other mutation remains forbidden.

## Outcome and status block (CL-D13, CL-D14)

Use these tokens exactly:

```text
IMPLEMENTATION_READY
WAITING_FOR_OWNER
ROUND_LIMIT_REACHED
BLOCKED
ABORTED
```

Outside CL-D31, declare `IMPLEMENTATION_READY` only when both gates returned `MERGE` against the current `issue_spec`, every finding has a disposition, no owner decision is pending, and **the approved specification is the published specification**. During ordinary CL-D31, the gates match the base `issue_spec` and exact frozen candidate, then the post-gate preview supplies authority; under CL-D32, the unchanged combined response replaces that later prompt and never authorizes skipping the mandatory rereview. In either route readiness requires every finding dispositioned, no decision pending, and the complete snapshot-C proof of the final published `issue_spec`, exact body, and exact new ledger comment, without duplicate gates.

A run that drafts a revision before CL-D31 candidate construction ends at `WAITING_FOR_OWNER`; the legacy review-only gate approved text the Issue does not yet contain. During ordinary CL-D31, only the post-gate/pre-attempt `WAITING_FOR_OWNER` state carries the active exact same-session preview and may proceed through the bounded attempt. Under CL-D32, the pre-rereview combined response is the active same-session approval; once its unchanged Sol and Terra gates match, it replaces the later prompt, so no second approval, command, or fresh run is requested. A pre-mutation mismatch or any post-first-mutation failure also reports `WAITING_FOR_OWNER`, but it is audit-only with expired, non-reusable authority and a fresh equivalent command as the only next action. After any operator-posted revision outside that attempt, recompute `issue_spec` and rerun both gates against the exact authoritative text.

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

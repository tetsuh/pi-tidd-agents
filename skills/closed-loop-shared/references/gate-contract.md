# Shared gate contract

This documentation-only reference is read by both workflow roots. It owns only policy common to Issue and PR readiness; it selects no workflow, mode, agent, status, publication action, or mutation authority. Workflow-specific target-kind rejection, agent sets, external-review rules, mode behavior, and publication boundaries remain in their owning files.

## Target grammar (CL-D7, CL-D8)

Accept a full GitHub URL, `#123`, `123`, `Issue #123`, `PR #123`, or `PR123`.

The prompt template passes the complete raw argument vector (`$@`) to the workflow Skill. Parse the complete raw argument vector before calling `gh`: recognize `Issue`/`PR` followed by `#123` as one two-token reference, recognize the other forms as one token, and consume only that target reference. The two-token reference is consumed greedily. Remaining-token handling belongs to the workflow root: Issue rejects remaining tokens; PR applies CL-D6 mode parsing and then rejects leftovers and near-misses. The target is **never inferred from the current branch**.

A target in another repository may be reviewed, but publication and local implementation authority remain bound to the repository of the current checkout. Verify that the resolved target is the expected kind after this shared parse; the workflow root applies its wrong-kind rejection and foreign-target boundary. The target is never inferred from the current branch.

## Name-level agent resolution (CL-D22, CL-D5)

Preflight begins by confirming that subagent execution comes from `pi-subagents`. If `pi-subagents` is unavailable, stop and report `BLOCKED` with installation guidance. Never substitute local execution for a formal gate.

Refer to agents **by runtime name** only, **never by model ID**. User and project agent definitions take discovery precedence over package-provided definitions with the same runtime name, so an operator whose environment lacks a model can supply their own definition under the same name through name-level override guidance. Naming a model here would remove that escape hatch. Each workflow root retains its own required runtime-agent set and routing.

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
- Write pull-request titles, bodies, summaries, and review replies in `github.pull_request`.
- Use the configured GitHub destination language for the current workflow; replies posted on a pull request use the pull-request language regardless of which service raised the finding.
- For any destination under `external_sites` that has no configured language, **stop and ask before drafting content for that destination** rather than guessing. The trigger is drafting, not posting. Workflow-specific mutation exceptions remain in their owning files.
- This profile **never governs source code**, code comments, repository documentation, or commit messages. Those follow project instructions.

Quote source text verbatim when quoting is needed.

## Sol adversarial consistency check (AC-ADVERSARIAL, CL-D29)

Treat the exact Issue or pull-request body, the current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable assertions in the workflow Skills, loaded non-Skill shared references, and selected mode reference as **claims to verify, not assumed context**. Semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including claims expressed with examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, or `exactly`; do not search keywords without understanding the claim.

Attempt falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence. When a named authoritative record is absent, that absence is not itself a finding; report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable. A finding requires either an actual cited counterexample that disproves the claim or a verdict-material claim that cannot be verified because required evidence is unavailable. Never invent a counterexample. No counterexample is neither a finding nor proof that the claim is correct.

Limit authoritative comments consistently with CL-D9: accept only comments by a non-bot author with `author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`, and do not revive superseded comments from #3. Report the claim, evidence searched, and the cited counterexample or unavailable evidence.

### Finding anchoring and threat-model bound (AC-ANCHOR, CL-D34)

Every `Blocker` or `Major` finding names the acceptance criterion, contract clause, or fail-stop invariant its counterexample falsifies; that anchor set replaces the older acceptance-criterion-only test, so a clause or invariant anchor is sufficient and a finding naming none of the three is an out-of-scope improvement rather than a blocker. A claim that appears only in target-body prose and names none of the three is a `reword` finding: its correction is an owner edit of the body, never an implementation blocker. A counterexample that requires violating an assumed operator condition declared cooperative by the selected mode's threat model is a `follow-up` finding reported with a proposed issue title; it is not a blocker. When an acceptance criterion, contract clause, or fail-stop invariant names that operator condition, the threat model no longer excludes it and the finding is `criterion-anchored` at its own severity. Label every finding that is not an out-of-scope improvement with exactly one of the three anchoring classes `criterion-anchored`, `reword`, or `follow-up`; `out-of-scope` remains the pre-existing residual label outside that set and is unchanged by CL-D34. Bounding applies to severity and disposition only: Sol still reads implementation and tests completely and still reports every cited counterexample.

## Gate verdicts (CL-D1)

Every gate must end with a verdict line using exactly this vocabulary:

```text
MERGE | FIX BEFORE MERGE | NEEDS DECISION
```

Require that verdict line in every invocation payload rather than relying on an agent to supply one. Only the parsed verdict decides whether a gate passed. Never read approval into prose. **Do not modify any file under `agents/`**: existing agents must stay unchanged and independently usable.

A missing or unparsable verdict is a tool-level failure. Ordinary workflow-specific retry and fail-stop behavior belongs to the selected owning workflow or mode reference; shared policy does not grant a retry, publication, or mutation. `ROUND_LIMIT_REACHED` is the round-budget outcome when the applicable gate reaches its limit.

## Invocation payload (CL-D2)

Every agent in this package sets `inheritSkills: false`, so nothing in a workflow Skill reaches a subagent automatically. The payload must name the exact issue body or exact pull-request body under review as applicable. **Nothing may rely on a child inheriting this skill.**

### Run-invariant payload blocks (CL-D2, CL-D29)

Defining them once does not reduce the transmitted size of any invariant block. The parent must include each applicable block verbatim in every applicable invocation. Every formal Issue and PR Sol/Terra route uses the every-gate block. Every Sol route—including Issue candidate and CL-D32 post-decision rereviews and exact-autofix post-push Sol—also uses the Sol-only block. Each gate also gets exactly one owning-root role block. Shared blocks grant no writer authority; Luna gets only the autofix writer authority, never a gate verdict block.

#### Every-gate invariant payload block (CL-D2)

The formal gate child is read-only and must not edit files, change Git state, post to GitHub, mutate provider or external services, or launch subagents. The required verdict vocabulary is exactly `MERGE | FIX BEFORE MERGE | NEEDS DECISION`, and that verdict must be the final line. Findings state severity, evidence, impact, and smallest correction. The child must stay within the supplied scope and acceptance criteria and must not redesign approved decisions. A missing or unparsable verdict is a tool-level failure. Settled findings require materially new evidence to reopen, and an out-of-scope improvement is not a blocker.

#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)

Because `inheritSkills: false`, every initial Sol invocation and every Sol re-invocation must include this complete procedure in its payload. Copy this block in full for every initial and re-invoked Sol invocation, including Issue candidate and CL-D32 post-decision rereviews and every exact-autofix post-push Sol invocation. Treat the exact target body (the Issue or pull-request body as applicable), current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable assertions in the workflow Skill, loaded non-Skill shared references, and selected mode reference as claims to verify rather than context; semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, and `exactly` (not keyword-only); attempt falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence; when a named authoritative record is absent, treat that absence as not itself a finding and report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable; require an actual cited counterexample disproving the claim or report a verdict-material claim as unverifiable when required evidence is unavailable; never invent a counterexample; treat no counterexample as neither a finding nor proof; restrict authoritative comments to non-bot `OWNER`, `MEMBER`, or `COLLABORATOR` authors under CL-D9 and do not revive superseded comments from #3. Every finding must report the claim, searched evidence, and cited counterexample or unavailable evidence. A settled finding requires materially new evidence to reopen, and a finding that names no acceptance criterion, contract clause, or fail-stop invariant is an out-of-scope improvement rather than a blocker. Every `Blocker` or `Major` finding names the acceptance criterion, contract clause, or fail-stop invariant it falsifies; a claim found only in target-body prose naming none of the three is a `reword` finding corrected by owner body edit, not an implementation blocker; a counterexample requiring violation of an assumed operator condition declared cooperative by the selected mode's threat model is a `follow-up` finding with a proposed issue title, and is instead `criterion-anchored` at its own severity when a criterion, clause, or invariant names that condition; label every finding that is not an out-of-scope improvement with exactly one of the three anchoring classes `criterion-anchored`, `reword`, or `follow-up`, leaving the pre-existing out-of-scope residual label outside that set (CL-D34).

#### Volatile envelope and compact history projection

Supply this envelope alongside the invariant and owning-role blocks, not inside them: target, evidence fingerprints, exact body or diff, Language Profile, mode/gate correlation, and acceptance criteria the target must satisfy. Compact only gate history: full finding records only for unresolved findings and settled findings reopened by materially new evidence; other settled summaries carry stable finding ID, source gate, raised-against identity or fingerprint, disposition, confirmation gate or evidence, and counts grouped by settled disposition. Exact autofix retains mode-specific `blockerKey`. Reopening names materially new evidence and why the prior disposition no longer applies; re-raising one requires materially new evidence, never restatement.

## Base round accounting (CL-D11, CL-D12)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- If a later gate finding forces a change to something an earlier gate approved, the earlier gate must run again and consumes one of its own rounds.
- At the limit, ask the owner whether to grant more rounds. Workflow-specific candidate, retry, extension, and resume boundaries remain authoritative in their owning files.

`ROUND_LIMIT_REACHED` is reported when a gate reaches its limit. Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block so the owner can carry them forward. **Do not create a state file** to work around this; persistent workflow state is a later stage.

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

## Gate verdicts (CL-D1)

Every gate must end with a verdict line using exactly this vocabulary:

```text
MERGE | FIX BEFORE MERGE | NEEDS DECISION
```

Require that verdict line in every invocation payload rather than relying on an agent to supply one. Only the parsed verdict decides whether a gate passed. Never read approval into prose. **Do not modify any file under `agents/`**: existing agents must stay unchanged and independently usable.

A missing or unparsable verdict is a tool-level failure. Ordinary workflow-specific retry and fail-stop behavior belongs to the selected owning workflow or mode reference; shared policy does not grant a retry, publication, or mutation. `ROUND_LIMIT_REACHED` is the round-budget outcome when the applicable gate reaches its limit.

## Invocation payload (CL-D2)

Every agent in this package sets `inheritSkills: false`, so nothing in a workflow Skill reaches a subagent automatically. The payload must name the exact issue body or exact pull-request body under review as applicable. **Nothing may rely on a child inheriting this skill.** Each invocation must restate:

- the required verdict vocabulary and that the verdict must be the last line;
- that the child is read-only, or the exact bounded writer authority when the owning mode permits one;
- the target, its relevant evidence fingerprints, and the exact text or diff under review;
- the applicable Language Profile entries;
- the finding format: severity, evidence, impact, and smallest correction;
- the scope boundary, so the child does not redesign approved decisions;
- the acceptance criteria the target must satisfy, so that every finding can be traced to one;
- on a gate re-invocation, every finding from that gate's earlier rounds, plus the dispositioned findings of any gate that already passed, each with its disposition and rationale.

### Sol adversarial payload (AC-ADVERSARIAL-payload, CL-D29)

Because `inheritSkills: false`, every initial Sol invocation and every Sol re-invocation must include this complete procedure in its payload: treat the exact target body (the Issue or pull-request body as applicable), current authoritative decision record and comments supplied in the payload (only qualifying comments are authoritative), and applicable assertions in the workflow Skill, loaded non-Skill shared references, and selected mode reference as claims to verify rather than context; semantically enumerate universal, exclusive, exhaustive, otherwise absolute, and other absolute claims, including examples only (examples-only), `always`, `never`, `unique`, `every`, `all`, `no`, `sole`, `must`, and `exactly` (not keyword-only); attempt falsification against the authoritative files of the repository under review — its contract or decision records where they exist, implementation, and tests — together with available Git/GitHub evidence; when a named authoritative record is absent, treat that absence as not itself a finding and report a claim as unverifiable only when the evidence needed to check that specific claim is unavailable; require an actual cited counterexample disproving the claim or report a verdict-material claim as unverifiable when required evidence is unavailable; never invent a counterexample; treat no counterexample as neither a finding nor proof; restrict authoritative comments to non-bot `OWNER`, `MEMBER`, or `COLLABORATOR` authors under CL-D9 and do not revive superseded comments from #3. The payload must also require the claim, searched evidence, and cited counterexample or unavailable evidence in each finding.

A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is **settled**, and the payload must say so: re-raising one requires new evidence, not a restatement. A finding that traces to no acceptance criterion is an out-of-scope improvement rather than a blocker, and must be labelled that way instead of returning `FIX BEFORE MERGE`.

Without this the loop cannot terminate. Reviewers run with fresh context and `inheritSkills: false`, so a disposition the parent recorded is invisible to the next round, and any finding not literally fixed returns indefinitely.

## Base round accounting (CL-D11, CL-D12)

- A round is one completed gate invocation that returns a parsable verdict.
- Each gate allows **at most three** rounds. **The passing round counts.**
- Tool, provider, startup, stale-target, and unparsable-verdict failures **do not consume a round**.
- If a later gate finding forces a change to something an earlier gate approved, the earlier gate must run again and consumes one of its own rounds.
- At the limit, ask the owner whether to grant more rounds. Workflow-specific candidate, retry, extension, and resume boundaries remain authoritative in their owning files.

`ROUND_LIMIT_REACHED` is reported when a gate reaches its limit. Round budgets are **run-scoped**. This MVP keeps no state between invocations, so re-running the command resets every counter. Report rounds used per gate in every status block so the owner can carry them forward. **Do not create a state file** to work around this; persistent workflow state is a later stage.

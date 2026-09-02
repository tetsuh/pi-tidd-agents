# Exact PR autofix mode

## Autofix (AC-AUTOFIX, CL-D3, CL-D4, CL-D10)

### Language Profile (CL-D16)

Exact PR `autofix` permits only `REPLY_EXCEPTION` (defined below); all other provider, external, and review-service mutations remain forbidden.

The exact PR `autofix` token itself selects and approves only the bounded CL-D30 actions: one validated correction batch per reviewed public head, its one normal commit and one non-force push, and parent-owned confirmed source-finding replies. Everything else remains forbidden; the token does not authorize merge, force-push, amend, rebase, history rewriting, branch-protection or ruleset bypass, comments outside confirmed source replies, external-service changes, approval, thread resolution, Issue mutation, or aggregate-summary posting. Only `REPLY_EXCEPTION` permits provider mutation.

### Isolated exact-autofix invariants (CL-D10, CL-D30)

- `OPERATOR_CHECKOUT@H` := captured target/path/HEAD/branch at initial public `H`, clean tracked/index, no unexpected non-ignored untracked paths, and opaque ignored inventory; `H` becomes operator baseline `O`.
- `AUTOFIX_WORKSPACE@H` := external run-owned detached linked worktree (`git worktree add --detach`) or temporary clone fallback at public `H`, binding repository/source/origin/fetch/push/branch/tree without operator-path copy.
- `WORKSPACE_POST_COMMIT(C, P)` := workspace `C` has sole parent/current public `P`; manifest/tree/blob and tracked/index/unstaged state match exactly.
- `WORKSPACE_POST_PUSH(C, O)` := public/workspace `C` with no-replace sole-parent `O -> C` and clean state; linked permits only verified remote-tracking `O -> C`, clone operator stays `O`.
- `OPERATOR_CHECKOUT_UNCHANGED@O` := equality to the immutable baseline's identity, tracked/index, unexpected-non-ignored-untracked, ref/config/tracking, and opaque ignored observations.
- `REPLY_EXCEPTION` := the sole provider-mutation exception for a confirmed source-finding reply.

`RUNTIME_ROOTS := { ".pi", ".pi-subagents" }` stays outside owner inventory; classify each independently and no-follow as absent or a real directory. The opaque sorted ignored inventory explicitly enumerated by NUL-delimited normalized checkout-relative paths rejects absolute, empty, dot/dot-dot, unreadable, replaced, renamed, ambiguous, or unstable re-enumeration; read no contents, targets, sizes, timestamps, hashes. Every Git command uses exact cwd, sanitized noninteractive env, isolated config, verified empty run-owned hooksPath, and no inherited helper/filter/fsmonitor/signing/pager/editor. Linked permits shared objects, its run-owned registration, per-worktree administration; clone binds source/origin fetch/push URLs. Operator config/branch/index unchanged; remote reads update no ref; gates/writer/validation use workspace cwd. The run-owned `VALIDATION_SANDBOX_DELTA` stays outside correction/evidence/manifest/commit/published trees; drift/staging blocks. Partial/ambiguous creation/verification is terminal; clone fallback requires linked unavailability and proof of no path, registration, or metadata side effect.

After any success/failure terminal observation, linked mode alone permits exact identity-reverified non-force `git worktree remove` with unchanged path/registration/per-worktree/common-Git-dir binding. Cleanup identity mismatch/failure is `BLOCKED` with no further action; recovery, compensation, force, prune, recursive deletion, clean, clone deletion, and operator cleanup are forbidden. Under CL-D49, a successful `workspace_cleanup` result is the terminal workspace evidence: it carries the removed path and the terminal head and tree, so no `workspace_*` operation may target the removed path afterwards and the terminal recheck after removal is operator-side only, and a post-removal verification failure is a caller error, never evidence about the target.

### Missing worktree registration reporting (CL-D40)

A missing path does not prove a stale worktree registration. `workspace_create` must ignore unrelated missing registrations, allocate a unique generated root, and distinguish no registration, an exact registration collision, and partial creation with read-only repository/common-Git-dir/path-kind/HEAD/detached/branch/prunable/locked/valid-receipt/root-source evidence. The failed run never retries or removes anything and must never recommend `git worktree prune`, force, recursive deletion, or direct Git-administration deletion. Only when that evidence proves the exact repository, missing non-symlink path, detached expected HEAD, unlocked state, and intended registration may the parent draft non-force `git worktree remove <exact-path>` with pre/post checks as a new owner action outside the failed run. Unverifiable identity yields no mutation command. After an independently completed exact removal, require a fresh invocation; never resume.

### Packaged helper invocation map (CL-D30, Issue #47)

Obtain every check below from the packaged CLI, `node <package>/skills/closed-loop-pr/helpers/cli.js`: one JSON v1 request on stdin as `{"version":1,"operation":<name>,"data":{...}}`, one JSON v1 envelope on stdout. Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL. An unknown operation, unknown or missing field, or `ok:false` envelope stops the run at that phase with its `code` and `phase`; no retry beyond the CL-D39 recovery defined above.

| Phase | Operation | Required data |
|---|---|---|
| Preflight, before any gate or mutation | `operator_capture` | `cwd`, `identity` |
| Preflight writability | `writability` | `owner`, `repo`, `branchRef`, `enterprisePolicyComplete`, `enterpriseRulesets` |
| Workspace creation at public `H` | `workspace_create` | `cwd`, `head`, `tree` |
| Snapshot refresh — before each Sol/Terra invocation, before the first reply, each reply batch, final classification, post-reply, summary mutation | `snapshot` | `owner`, `repo`, `number` |
| CL-D9 `issue_spec` | `fingerprint_issue_spec` | `body`, `comments` |
| CL-D9 `pr_base` | `fingerprint_pr_base` | `oid` |
| CL-D9 `pr_tree` | `fingerprint_pr_tree` | `oid` |
| CL-D9 `pr_diff`, the exact binary effective diff | `fingerprint_pr_diff` | `base64` |
| CL-D9 `pr_commits` | `fingerprint_pr_commits` | `commits` |
| CL-D9 `pr_head` | `fingerprint_pr_head` | `oid` |
| Snapshot fingerprint for that evidence | `fingerprint_snapshot` | `snapshot` (data of `snapshot`) |
| `AUTOFIX_WORKSPACE@H`/`@P` at every pre-push boundary — before each gate, route-to-Sol, reply, final classification, post-reply, summary mutation — and before any edit, including immediately before delegating Luna | `workspace_verify` | `cwd`, `expected` (data of `workspace_create`) |
| Sole-parent transition evidence toward `WORKSPACE_POST_COMMIT(C, P)`, `WORKSPACE_POST_PUSH(C, O)` | `workspace_verify` | `cwd`, `expected` (data of `workspace_create`), `transition` |
| `OPERATOR_CHECKOUT_UNCHANGED@O` at every pre-push boundary — before each gate, route-to-Sol, reply, final classification, post-reply, summary mutation — and every terminal recheck | `operator_revalidate` | `captured` (envelope of `operator_capture`), `cwd` |
| Optional linked cleanup at a terminal observation | `workspace_cleanup` | `receipt` (receipt inside `workspace_create` data), `cwd` |
| Every Sol or Terra result, before it is read as a verdict (CL-D36) | `gate_result_validate` | `result` (structured gate output), `expected` |
| Reply body construction (CL-D45) | `marker_create` | `binding`, `visibleBody` |
| Post-attempt reconciliation (CL-D45) | `marker_reconcile` | `binding`, `visibleSha256`, `source`, `comments`, `paginationComplete`, `currentHead`, `expectedAuthor` |
| Before each gate invocation, on the assembled evidence (CL-D42) | `evidence_verify` | `envelope`, `expected` |
| Construct the revalidation request from the capture it revalidates (CL-D56) | `build_operator_revalidate` | `captured` (envelope of `operator_capture`), `cwd` |
| Construct the verify request from the workspace it verifies (CL-D56) | `build_workspace_verify` | `created` (data of `workspace_create`), `cwd` |
| Construct the cleanup request from the workspace's own receipt (CL-D56) | `build_workspace_cleanup` | `created` (data of `workspace_create`), `cwd` |
| Construct the snapshot-fingerprint request (CL-D56) | `build_fingerprint_snapshot` | `snapshot` (data of `snapshot`) |
| Construct the gate expectation and the canonical result schema (CL-D36, CL-D56) | `build_gate_expectation` | `workflow`, `correlation`, `assignedFindings`, `requiredEvidence` |
| Immediately before Luna's first edit, on the authorized correction set (CL-D57) | `guard_before_edit` | `cwd`, `expected` (data of `workspace_create`), `authorizedPaths` |
| Immediately after editing, freezing the authorized overlay (CL-D57) | `overlay_freeze` | `cwd`, `authorizedPaths` |
| At each later overlay boundary, re-observing the frozen overlay (CL-D57) | `overlay_compare` | `cwd`, `overlay` (data of `overlay_freeze`) |
| At `AFTER_STAGING` (capture) and `BEFORE_COMMIT` (compare) (CL-D57) | `manifest_compare` | `cwd`, `parent`, exactly one of `authorizedPaths` or `manifest` (data of `manifest_compare`) |

`workspace_verify` requires clean tracked and index state, so it does not serve `BEFORE_VALIDATION`, `AFTER_VALIDATION`, `BEFORE_STAGING`, `AFTER_STAGING`, or `BEFORE_COMMIT`: those guards keep their phase-specific frozen-overlay and staged-manifest delta checks, which this map does not reassign. Its transition form supplies only clean workspace identity, current `HEAD`, and a verified sole-parent transition; current public-head equality, staged manifest/tree/blob identity, and linked remote-tracking equality remain phase-specific checks this map does not reassign. After public/workspace `C`, linked alone passes `postPushHead:C`; clone omits it and requires `O` equality. A helper envelope is supplied evidence in the gate payload: it never substitutes for a gate verdict and grants no commit, push, reply, or provider authority.

Request builders (CL-D56): each documented composition has a package-owned builder that constructs the consuming request from its producing operation's result and validates the construction with the boundary's own predicates before returning it, so a builder output the boundary would reject is unrepresentable. Builders are read-only, reach no network, filesystem, or Git, and grant no authority; each rejects invalid inputs with the boundary's vocabulary at phase `build`. `build_gate_expectation` additionally returns the canonical CL-D36 structured-output schema, so the parent copies a derivation instead of re-authoring one — CL-D47's rule applied to schemas. Prefer a builder over hand-assembly wherever one exists.

Packaged guards (CL-D57): the batch-sequence boundary checks are packaged operations whose failures name the violated subcheck and the observed value, satisfying CL-D55 by construction. Their predicates encode the recorded failure classes: authorized paths are a maximum set: the overlay must stay inside them and must not be empty, but no authorized path is required to change; and `manifest_compare` compares the index against the immutable staged manifest, never against only the authorized changed files, so an entry the parent commit already carries cannot be misclassified. Guards are read-only observations and grant no authority; a true failure keeps its CL-D39 consequences unchanged.

### Cross-operation input shapes (CL-D44)

`envelope`, `data`, and `receipt` are distinct input shapes: the complete protocol document `{ version, ok, operation, data }`, that document's `data` object, and the run-owned cleanup receipt nested inside `workspace_create` data. They are structurally similar and easy to substitute for one another, so the map names the shape each field expects, not only the field. Shape is decided by structure, never by what a caller names it, and no shape is accepted as a tolerant alternative for another. Accordingly, a supplied shape that is not the declared one stops with `input_shape_mismatch` before the operation runs, naming the field, the declared shape, and what arrived — never as a later identity, capture, or evidence failure that points at the target instead of the request. The check is part of request validation, so it consumes no counter, grants no authority, and is not recoverable under CL-D39, which classifies only the keys it already names.

The check separates the declared shapes from one another; it is not a validator of producer output. Each field carries one predicate for its declared shape, and a supplied value is rejected because it fails that one predicate, never because of what it was recognized to be, so the rejection side stays closed without enumerating other shapes. Predicate depth is calibrated to what fails downstream: `snapshot` carries the full producer shape because `fingerprint_snapshot` hashes any object silently, while `result` is only a separating probe because the closed CL-D36 schema remains the sole validator of gate results. An object constructed by hand to satisfy a declared predicate passes: detecting fabricated producer output is outside this boundary, exactly as CL-D42 does not detect a hand-retyped value. The five declared fields are the complete CL-D44 set, joined under CL-D57's authority by the three guard fields — `guard_before_edit.expected`, `overlay_compare.overlay`, and `manifest_compare.manifest`, the last validated only when supplied — exactly the new-owner-decision route this freeze names; declaring another field, changing a predicate's depth, or accepting a second shape for any field requires a new owner decision.

### Bounded pre-writer recovery (CL-D39)

One recovery is permitted for either a deterministic local tooling failure under the original CL-D39 rows or the CL-D51 pure gate transport failure with zero designated output bytes, and only when all hold: no repository, Git, GitHub, provider, or external mutation was attempted other than the already-authorized setup effects, namely `workspace_create`'s external run root, linked-worktree registration or clone, and receipt, and the packaged helpers' ephemeral process-isolation root `pi-tidd-pr-helper-*` with its `home`, `hooks`, `global.gitconfig`, and `system.gitconfig`; no correction, publication, provider, target, or operator mutation exists; no Luna task, commit, push, or reply exists; `OPERATOR_CHECKOUT_UNCHANGED@O` and `AUTOFIX_WORKSPACE@H` are freshly re-proved; identity and every applicable fingerprint are unchanged; the failure was either local parsing, rendering, schema access, or report verification, or the CL-D51 pure gate transport failure with zero designated output bytes; the failed operation is replaced by a prevalidated one, never repeated blindly; and the budget is exactly one per key, tracked run-locally.

Each failure has one canonical `operation@phase` key. The operation part is the packaged CLI operation that failed, so each `fingerprint_*` operation is its own key, or `envelope_read` or `report_verify` for the two parent-side steps; a helper envelope's `phase` field names the failed operation, not the key's phase. The phase part is `preflight`, `gate_launch`, `gate_result`, or `normalize` before any edit, and the guard or step name from Luna's batch sequence after. The replacement retains the key, so a replacement failure is the second failure of that key and is terminal. Recovery preserves evidence already proved unchanged and invalidates only the failed operation's own output.

| Failure | Key | Prevalidated replacement | Outcome | Evidence |
|---|---|---|---|---|
| wrong key read from an evidence envelope | `envelope_read@normalize` | reread through the operation's declared field | recoverable | envelope preserved; derived value invalidated |
| malformed local inspection command | `report_verify@normalize` | the operation named in the report envelope's own `operation` field, read directly as `envelope_read`; never run-time shell | recoverable | inputs preserved; report invalidated |
| digest computed from the wrong domain | `fingerprint_<op>@normalize` | the operation declaring that domain | recoverable | source bytes preserved; digest invalidated |
| validation harness could not run | `validation_harness@focused_validation` | none | terminal | post-writer; all evidence stands |
| over-specific staged-manifest assertion | `manifest_compare@AFTER_STAGING` | none | terminal | post-writer; all evidence stands |
| gate transport failure with zero designated output bytes | `gate_transport@gate_launch` | one relaunch of the same prevalidated invocation | recoverable | no output existed; nothing is preserved or invalidated |

Every key not listed is terminal: identity, writability, workspace, API, and child startup at `preflight` and `gate_launch` except the CL-D51 zero-output transport key; malformed verdict, correlation mismatch, and stale target at `gate_result`; evidence movement at `normalize`; and every failure from the first Luna task onward. Recovery never launches a second writer, repeats a provider mutation, or re-enters a phase after Luna starts. For the CL-D51 key: any designated output byte, however malformed, keeps the failure terminal; at most one relaunch per run, consuming no counter, with identity, every applicable fingerprint, and both live invariants freshly re-proved first; after any mutation, Luna task, or reply the key is terminal exactly as before.

### Versioned evidence envelope (CL-D42)

Gate evidence travels in one closed envelope carrying `schemaVersion`, capture identity, seven fingerprints, both capture brackets, and completeness; an unknown or absent version fails closed before any field is read. Under version 1 each `fingerprint_*` operation emits its own labelled record and envelope assembly carries it unchanged, so every fingerprint travels as `{ domain, encoding, value }`; a record whose `domain` differs from the field holding it is rejected. `raw_bytes`, `normalized_text`, and `canonical_json` are distinct byte domains with fixed fields and shapes. `evidence_verify` is read-only and repeatable and rejects a moved capture bracket, incomplete pagination or completeness metadata, every identity field or fingerprint value differing from the expected target, and internal identity disagreement. It grants no verdict or mutation authority; failure is terminal except where CL-D39 names that key recoverable. This defeats a record copied from the wrong operation; constructing a new record from a bare value is outside the required assembly path, and a value retyped by hand into a well-formed record is not detectable here.

### Worktree precondition (CL-D10)

Before the first gate or mutation, the operator runs `gh pr checkout` when needed. Exact PR `autofix` then verifies the target PR is open and non-draft, and requires the head branch to be verified writable by a normal actor-authorized non-force push without branch-protection or ruleset bypass. It captures `OPERATOR_CHECKOUT@H` and creates/verifies `AUTOFIX_WORKSPACE@H` outside the repository before any gate. Writability result must be unambiguous; a missing, rejected, ambiguous, unavailable, or bypass-dependent result fails closed before review or mutation. A branch is not writable when success depends on the actor's bypass permission. Publication is exactly `git -C <AUTOFIX_WORKSPACE> push origin HEAD:refs/heads/<verified-pr-branch>` with the bound identities, normal fast-forward semantics, no force, and no local PR-ref movement. Operator tracked/index change or any unexpected non-ignored untracked path blocks; ignored owner paths and `RUNTIME_ROOTS` use the rules above. No resume; every terminal success/failure performs a terminal operator recheck. Never switch, stash, reset, clean, delete, or discard operator work.

### The writer (CL-D3)

For exact `/tidd-pr ... autofix`, `tidd-autofix-worker` is mandatory: it is the sole correction writer and publisher, never merely a default. The package ships no other worker: a gate verdict here is an automated exit condition rather than advice to a human, so a model must not grade its own fixes, and the shipped writer default **keeps the closed-loop requirement inside one model family**.

A run has **exactly one writer**. If Luna fails to start, stop. **Do not fall back to another worker**: a partially written tree followed by a second writer breaks the single-writer guarantee. An owner request or selection of any other worker is a CL-D30 contract change: stop before mutation, end the exact-autofix run, and do not resume it. Standalone explicit worker delegation outside this `/tidd-pr ... autofix` workflow may select another worker under its separate permissions, but it receives no CL-D30 authority and cannot make the exact-autofix writer replaceable.

Formal reviewers are read-only and never become writers. Synthesize the findings yourself, then hand Luna one bounded instruction set.

**Never create `context.md` or `plan.md`** to brief the worker. Pass everything inline in the invocation payload. If files with those names already exist they belong to the project and are read-only inputs.

Apply only the **smallest correction** that satisfies a finding inside the approved contract. Stop before any unapproved product, API, architecture, scope, compatibility, or risk decision. After fixes, run focused validation and rerun each gate whose evidence the change invalidated.

### Candidate evidence boundary (CL-D23, CL-D9)

Exact PR `autofix` submits only the published public-head OID to formal gates after Luna's normal commit and verified push. The legacy `candidate_diff` field is not an exact-autofix identity and is not used to authorize, resume, or gate any candidate.

### Target stability during a run (CL-D27)

Autofix edits files while the target may be moving. Re-resolve the target identity — repository, pull-request number, head branch, PR head SHA, base OID — immediately before **every** gate invocation, and require it to be unchanged.

If anything changed, **stop rather than continue against a moved target**. Never clean, normalize, discard, stash, or switch anything in order to make the check pass; report what moved instead.

## Publication (AC-GRANT, CL-D28, CL-D30)

Only the exact PR `autofix` mode token supplies a run-scoped publication grant for the bounded actions in the CL-D30 addendum below. For each validated correction batch against one reviewed public head/gate result, it may authorize one bounded normal commit, one non-force push to the current PR head branch, and parent-owned confirmed source-finding replies. The run-wide cap is five successful correction pushes; it is not a one-push-per-run rule. It never authorizes merge, force-push, amend, rebase, history rewrite, ADR acceptance, authoritative Issue changes, failed-gate bypass, review approval, thread resolution, aggregate summary posting, or a different repository, PR, or branch. Provider mutation is limited to `REPLY_EXCEPTION`. The CL-D31 exception does not originate from `/tidd-pr`; exact PR `autofix` never performs Issue publication. The grant is bound to the complete target identity and expires when the run ends, is interrupted, fails, or changes target.

A normal commit follows CL-D25: a Conventional Commits subject, issue-number reference, and test provenance in the body. For multiline messages, write real UTF-8 newline bytes to a file and use `git commit -F`; never encode literal `\\n` sequences.

The exact `autofix` token additionally selects the CL-D30 addendum in `references/autofix-addendum.md`; read it only then, after this reference (CL-D50).

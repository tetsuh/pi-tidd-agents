# Closed-loop workflow contract

The authoritative record of the decisions the closed-loop skills implement.

These decisions were made during [#3](https://github.com/tetsuh/pi-tidd-agents/issues/3) and its implementation in [#6](https://github.com/tetsuh/pi-tidd-agents/pull/6). The [decision comment on #3](https://github.com/tetsuh/pi-tidd-agents/issues/3#issuecomment-5076813054) is the historical record and is superseded by this file, which moved here under CL-D26 because #3 closed.

`CL-D*` entries are decisions taken while implementing the workflow. `AC-*` entries are obligations that come from #3's acceptance criteria rather than from a decision; they are recorded here so every clause resolves to something. `DEC-*` entries are owner decisions taken during a run.

**How this file is enforced.** Each record's clause pins live beside it in `contract/<id>.clauses.json` (CL-D105) and map each obligation to literal text that must appear in a named file, and `test/contract-record.test.js` checks that every clause resolves to a decision here and that every decision here either owns a clause or is annotated `**Clauses:** none — structural`. Adding a clause without a decision, or leaving a decision with nothing enforcing it, fails the build. A record is written only for a decision that changes an obligation; a figure, path or wording choice is a forward note in the record that holds it (CL-D106). Three contract changes reached `main` without a record while that record lived in a GitHub comment; nothing could check a comment.

**What a clause can and cannot prove.** A clause proves that required text is present. It cannot prove a document says only one thing: three contradictions passed review because every required literal sat in the stale half of a superseded rule. Retired wordings are therefore named explicitly in the superseded-rule guard in `test/closed-loop-regressions.test.js`. A clause without a `section` is matched against the whole file, which is weaker than it looks: a literal deleted from one place can still match an unrelated mention elsewhere. Record formats are therefore pinned whole and scoped to a section.

---

## Record index

Each record is its own file under `contract/`, listed here in order. The contract is this preamble followed by every record file in this order, one blank line apart (CL-D103).

- [contract/CL-D1.md](contract/CL-D1.md) — Gate verdicts are supplied by the caller, not by agent files
- [contract/CL-D2.md](contract/CL-D2.md) — Every constraint is restated in the invocation payload
- [contract/CL-D3.md](contract/CL-D3.md) — Writer selection
- [contract/CL-D4.md](contract/CL-D4.md) — Do not use `context.md` / `plan.md`
- [contract/CL-D5.md](contract/CL-D5.md) — `pi-subagents` is a hard runtime dependency
- [contract/CL-D6.md](contract/CL-D6.md) — Mode token parsing is exact and fails closed
- [contract/CL-D7.md](contract/CL-D7.md) — Target kind is verified, never assumed
- [contract/CL-D8.md](contract/CL-D8.md) — Targets outside the current repository
- [contract/CL-D9.md](contract/CL-D9.md) — Evidence-specific fingerprints
- [contract/CL-D10.md](contract/CL-D10.md) — Worktree precondition for autofix
- [contract/CL-D11.md](contract/CL-D11.md) — Round accounting
- [contract/CL-D12.md](contract/CL-D12.md) — Round budgets are run-scoped
- [contract/CL-D13.md](contract/CL-D13.md) — Status block and resume
- [contract/CL-D14.md](contract/CL-D14.md) — Canonical status tokens
- [contract/CL-D15.md](contract/CL-D15.md) — Scratch-file boundary
- [contract/CL-D16.md](contract/CL-D16.md) — Language Profile package defaults
- [contract/CL-D17.md](contract/CL-D17.md) — SonarCloud disposition
- [contract/CL-D18.md](contract/CL-D18.md) — External observation is reported, not enforced
- [contract/CL-D19.md](contract/CL-D19.md) — Division of responsibility between prompts, Skills, and mode references
- [contract/DEC-I22-PROMPT-AUTHORITY-001.md](contract/DEC-I22-PROMPT-AUTHORITY-001.md) — CL-D19 prompt authority
- [contract/DEC-I23-PAYLOAD-COMPACTION-001.md](contract/DEC-I23-PAYLOAD-COMPACTION-001.md) — Option A payload history compaction
- [contract/CL-D20.md](contract/CL-D20.md) — Precondition guard
- [contract/CL-D21.md](contract/CL-D21.md) — Test seam, tooling and CI
- [contract/CL-D22.md](contract/CL-D22.md) — Closed-loop model requirements and preflight
- [contract/CL-D23.md](contract/CL-D23.md) — Candidate evidence boundary by mode
- [contract/CL-D24.md](contract/CL-D24.md) — External observation is per-run and never carried forward
- [contract/CL-D25.md](contract/CL-D25.md) — Validated `pi-subagents` minimum, and what a normal commit is
- [contract/CL-D26.md](contract/CL-D26.md) — The authoritative contract record lives in this file
- [contract/CL-D27.md](contract/CL-D27.md) — Target stability during a run
- [contract/CL-D28.md](contract/CL-D28.md) — Mode-scoped publication boundary (historical no-publication rule)
- [contract/CL-D29.md](contract/CL-D29.md) — Sol attempts adversarial falsification of absolute claims
- [contract/CL-D30.md](contract/CL-D30.md) — Exact PR autofix publishes one bounded correction per public head
- [contract/CL-D31.md](contract/CL-D31.md) — Owner-gated Issue candidate publication
- [contract/CL-D32.md](contract/CL-D32.md) — Scope-freeze approval stays inside the candidate transaction
- [contract/CL-D33.md](contract/CL-D33.md) — Review-only drafts guarded owner-executed PR publication artifacts
- [contract/CL-D34.md](contract/CL-D34.md) — Sol findings are anchored to acceptance criteria and a declared threat model
- [contract/CL-D35.md](contract/CL-D35.md) — One-time removal of the unloaded intercom tool from the six agent allowlists
- [contract/CL-D36.md](contract/CL-D36.md) — Formal gate results travel as a strict structured envelope
- [contract/CL-D37.md](contract/CL-D37.md) — Bounded helper surface is structural
- [contract/CL-D58.md](contract/CL-D58.md) — The gate envelope is read from the structured output path, never from a notice
- [contract/CL-D59.md](contract/CL-D59.md) — Agent identities name workflow roles; models are deployment configuration
- [contract/CL-D60.md](contract/CL-D60.md) — Gate identities name workflow functions; schema version 2
- [contract/CL-D61.md](contract/CL-D61.md) — The manifest requests are built and the required-evidence set is checked before any gate
- [contract/CL-D62.md](contract/CL-D62.md) — A non-authoritative convergence stage runs before the adversarial gate
- [contract/CL-D63.md](contract/CL-D63.md) — Deterministic agreement checks are the first review layer
- [contract/CL-D64.md](contract/CL-D64.md) — The writer iterates on focused validation before the guard
- [contract/CL-D65.md](contract/CL-D65.md) — Gate children carry the envelope duties and validate their own envelope
- [contract/CL-D66.md](contract/CL-D66.md) — Same-class rigor gaps are named once and written exactly the first time
- [contract/CL-D67.md](contract/CL-D67.md) — Pull-request bodies carry no per-head facts
- [contract/CL-D68.md](contract/CL-D68.md) — The gate launch request and the designated-output read are packaged
- [contract/CL-D69.md](contract/CL-D69.md) — The evidence attestation carries no identity
- [contract/CL-D70.md](contract/CL-D70.md) — The declared envelope field accepts the producer payload
- [contract/CL-D71.md](contract/CL-D71.md) — The aggregate helper smoke alarm is reset a third time
- [contract/CL-D72.md](contract/CL-D72.md) — The focused validation is packaged and the alarm is reset for it
- [contract/CL-D73.md](contract/CL-D73.md) — The gate step composes no request by hand
- [contract/CL-D74.md](contract/CL-D74.md) — The post-commit message check is packaged
- [contract/CL-D75.md](contract/CL-D75.md) — A cleanup that cannot remove the root it emptied names it and still succeeds
- [contract/CL-D76.md](contract/CL-D76.md) — The cleanup builder takes its cwd from the receipt
- [contract/CL-D77.md](contract/CL-D77.md) — Every exact-autofix run ends with the owner publication artifacts
- [contract/CL-D78.md](contract/CL-D78.md) — A run reports the run roots it retained
- [contract/CL-D79.md](contract/CL-D79.md) — The post-push guard accepts a sole-child chain of pushes
- [contract/CL-D80.md](contract/CL-D80.md) — The exact-autofix writer launch carries no pi-subagents acceptance gate
- [contract/CL-D110.md](contract/CL-D110.md) — Review-only carries earlier rounds and stops after five without MERGE_READY
- [contract/CL-D109.md](contract/CL-D109.md) — The gate payload carries the diff as its own readable section
- [contract/CL-D108.md](contract/CL-D108.md) — A trusted timeline correction settles a body claim
- [contract/CL-D107.md](contract/CL-D107.md) — A gate result whose correlation names no run is relaunched once
- [contract/CL-D106.md](contract/CL-D106.md) — A record is written only for a decision that changes an obligation
- [contract/CL-D105.md](contract/CL-D105.md) — Each record's clause pins live beside it
- [contract/CL-D104.md](contract/CL-D104.md) — /tidd-pr runs through the packaged driver
- [contract/CL-D103.md](contract/CL-D103.md) — Every contract record is its own file; CONTRACT.md is the preamble and the record index
- [contract/CL-D102.md](contract/CL-D102.md) — A gate reports every finding it can establish in one invocation
- [contract/CL-D101.md](contract/CL-D101.md) — The gate launch names a verification request; the child copies no digest
- [contract/CL-D100.md](contract/CL-D100.md) — External review is best effort
- [contract/CL-D99.md](contract/CL-D99.md) — The correction push carries a lease on the head it was built on
- [contract/CL-D98.md](contract/CL-D98.md) — The Sol and Terra roles ship gpt-6.1-sol
- [contract/CL-D97.md](contract/CL-D97.md) — Validation commands without a committed .tidd.json
- [contract/CL-D96.md](contract/CL-D96.md) — The packaged autofix driver runs correction cycles; the writer's process commits and pushes
- [contract/CL-D95.md](contract/CL-D95.md) — A repository's own pull-request template governs the body's sections
- [contract/CL-D94.md](contract/CL-D94.md) — Every gate launch carries a 60-minute bound
- [contract/CL-D93.md](contract/CL-D93.md) — A packaged driver sequences the review; the parent only makes the calls it prints
- [contract/CL-D92.md](contract/CL-D92.md) — The snapshot classifies CodeRabbit's review state
- [contract/CL-D91.md](contract/CL-D91.md) — The gate launch carries a pointer to a verified payload file
- [contract/CL-D90.md](contract/CL-D90.md) — The gate schema lives in the gate roles' agent definitions
- [contract/CL-D89.md](contract/CL-D89.md) — The writer commits and pushes through packaged operations with the operator identity
- [contract/CL-D88.md](contract/CL-D88.md) — The workspace verification runs in the workspace the run created
- [contract/CL-D87.md](contract/CL-D87.md) — The package ships gpt-6-sol and gpt-6-luna
- [contract/CL-D86.md](contract/CL-D86.md) — The post-push revalidation is composed from the run's own snapshots
- [contract/CL-D85.md](contract/CL-D85.md) — Wording-only Minors do not stop a run
- [contract/CL-D84.md](contract/CL-D84.md) — The terminal cleanup is one packaged operation
- [contract/CL-D83.md](contract/CL-D83.md) — The packaged helper invocation map is its own reference
- [contract/CL-D82.md](contract/CL-D82.md) — The gate launch names the workspace its child runs in
- [contract/CL-D81.md](contract/CL-D81.md) — The exact-autofix writer launch is composed by a packaged builder
- [contract/CL-D38.md](contract/CL-D38.md) — Review-only tolerates the validation sandbox delta it created
- [contract/CL-D39.md](contract/CL-D39.md) — Exact autofix gains one bounded pre-writer recovery
- [contract/CL-D40.md](contract/CL-D40.md) — Missing worktree paths require exact registration evidence
- [contract/CL-D42.md](contract/CL-D42.md) — Evidence travels in one versioned envelope with labelled domains
- [contract/CL-D43.md](contract/CL-D43.md) — Authority byte guards are set once, with headroom
- [contract/CL-D44.md](contract/CL-D44.md) — Cross-operation input shapes are declared and checked
- [contract/CL-D45.md](contract/CL-D45.md) — Source replies carry deterministic markers and reconcile read-only
- [contract/CL-D46.md](contract/CL-D46.md) — Embedded repositories in the inventory are entries, not crashes
- [contract/CL-D47.md](contract/CL-D47.md) — The fresh-finding namespace is derived, never supplied
- [contract/CL-D48.md](contract/CL-D48.md) — The authority headroom property is asserted at the raise
- [contract/CL-D49.md](contract/CL-D49.md) — A successful cleanup result is the terminal workspace evidence
- [contract/CL-D50.md](contract/CL-D50.md) — The CL-D30 addendum is a third disclosure stage
- [contract/CL-D51.md](contract/CL-D51.md) — A zero-output gate transport failure may relaunch once
- [contract/CL-D52.md](contract/CL-D52.md) — The stability digest ignores foreign-branch configuration
- [contract/CL-D53.md](contract/CL-D53.md) — The aggregate helper smoke alarm is reset after firing
- [contract/CL-D54.md](contract/CL-D54.md) — Review-only tolerates the runtime roots the harness itself writes
- [contract/CL-D55.md](contract/CL-D55.md) — A guard failure must name its failed subcheck
- [contract/CL-D56.md](contract/CL-D56.md) — Package-owned builders construct the documents the boundary checks
- [contract/CL-D57.md](contract/CL-D57.md) — The batch-sequence guards are packaged and the alarm is reset for them
- [contract/DEC-I15-ROUND-BUDGET-001.md](contract/DEC-I15-ROUND-BUDGET-001.md) — Bounded post-decision Sol round
- [contract/DEC-I13-ENTRYPOINT-029.md](contract/DEC-I13-ENTRYPOINT-029.md) — Equivalent Issue entrypoints
- [contract/DEC-EXT-SNAPSHOT-001.md](contract/DEC-EXT-SNAPSHOT-001.md) — External observation resumes by re-fetching
- [contract/AC-AUTOFIX.md](contract/AC-AUTOFIX.md) — Autofix token grants only bounded CL-D30 actions
- [contract/AC-DECISION.md](contract/AC-DECISION.md) — Owner decision record
- [contract/AC-DISPOSITION.md](contract/AC-DISPOSITION.md) — Finding disposition ledger
- [contract/AC-GATES.md](contract/AC-GATES.md) — Sequential Sol then Terra
- [contract/AC-GRANT.md](contract/AC-GRANT.md) — Run-scoped bounded publication grant
- [contract/AC-ISSUE-NO-EXTERNAL.md](contract/AC-ISSUE-NO-EXTERNAL.md) — Issue readiness excludes external gates
- [contract/AC-REVIEW-ONLY.md](contract/AC-REVIEW-ONLY.md) — Review-only is the default
- [contract/AC-TDD.md](contract/AC-TDD.md) — Risk-based test-first policy and truthful provenance

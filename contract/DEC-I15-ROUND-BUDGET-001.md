## DEC-I15-ROUND-BUDGET-001 — Bounded post-decision Sol round
**Clauses:** DEC-I15-round-budget
*Decision ID:* DEC-I15-ROUND-BUDGET-001
*Kind:* Scope and bounded workflow-authority decision
*Target and revision:* `tetsuh/pi-tidd-agents#15` at base `issue_spec` `7f8288e4293875a7764436569d57ac974cd4a50d6b6bf64af08c4e9476eaa384`; the proposed Issue revision that incorporates the selected dormant-round semantics.
*Question:* Should a scope decision raised on the last authorized Sol round be excluded from the combined path, or should the exact combined response carry one dormant bounded post-decision Sol round?
*Options and trade-offs:* Option A: fail-closed exclusion, preserving existing round authority but retaining a second-response edge case. Option B: one dormant at-most-one counted Sol round bound to the exact candidate/session, adding narrow review-budget authority while preserving one-response routing.
*Recommendation:* Option B: include the dormant bounded round in the exact combined response, activate it only when no already-authorized round remains, and forbid retry, transfer, mutation authority, or further extension.
*Owner choice:* Option B approved by the exact live same-session response `推奨案を承認`.
*Rationale:* The last-round boundary must not undermine one-response routing. Option B removes that branching without skipping Sol, Terra, snapshots, or publication guards and grants no provider or implementation mutation.
*Validity and invalidation conditions:* Valid for the selected semantics in this Issue #15 revision and later faithful implementation until a later explicit owner-approved decision changes them. Candidate regeneration that preserves these semantics does not change this owner choice; any semantic expansion, additional round, retry, transfer, replay, durable resume, different candidate/session use, or changed authority requires a new owner decision. Before publication, authoritative target/input movement still invalidates the CL-D31 candidate and publication authority.

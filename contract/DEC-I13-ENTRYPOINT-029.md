## DEC-I13-ENTRYPOINT-029 — Equivalent Issue entrypoints
**Clauses:** DEC-I13-ownership, DEC-I13-decision, DEC-I13-publication
*Decision ID:* DEC-I13-ENTRYPOINT-029
*Kind:* public command contract and publication-authority boundary
*Target and revision:* `tetsuh/pi-tidd-agents#13` at the proposed revision based on published base `issue_spec` `7f527af828599860c4dcf2651c0bd329bca09e67c0c565dcf7e1616a2d5af0b7`
*Question:* Should direct `/skill:closed-loop-issue <ref>` invocation receive the same bounded publication authority as `/tidd-issue <ref>`?
*Options and trade-offs:* Treat the two entrypoints as equivalent and preserve one shared Skill contract, or keep direct Skill invocation review-only with a separate reliable fail-closed dispatcher. Equivalence preserves documented same-workflow behavior; divergence requires a new authority discriminator and separate documentation and tests.
*Recommendation:* Treat both spellings as equivalent Issue entrypoints with the same bounded authority and fresh-run semantics.
*Owner choice:* Equivalent entrypoints; authorize the same bounded Issue publication and recovery semantics through `/tidd-issue <ref>` and `/skill:closed-loop-issue <ref>` only.
*Rationale:* Both commands load the same authoritative Skill and are documented as the same workflow. Equivalence is the smallest consistent authority boundary and does not grant publication to PR commands, other aliases, foreign repositories, or unlisted actions.
*Validity and invalidation conditions:* This decision applies only to the two named Issue entrypoints and the Issue #13 bounded exception. It remains valid until a later explicit owner-approved contract decision separates the entrypoints or changes their shared Skill architecture.

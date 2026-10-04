## DEC-I22-PROMPT-AUTHORITY-001 — CL-D19 prompt authority
**Clauses:** none — structural
*Decision ID:* DEC-I22-PROMPT-AUTHORITY-001
*Kind:* owner decision
*Target and revision:* `tetsuh/pi-tidd-agents#22` at the 2026-08-10 JST implementation decision
*Question:* Should prompt templates restate workflow clauses or defer all workflow authority to the loaded Skills?
*Options and trade-offs:* Option A makes prompts thin dispatchers and keeps each workflow rule in one Skill authority; Option B permits selected safety-critical restatements but creates synchronization obligations; Option C permits only a narrow review-only exception while retaining multiple sources of truth.
*Recommendation:* Adopt Option A and make CL-D19 the sole authority boundary.
*Owner choice:* Option A approved by the owner response `OK. A で進めて`.
*Rationale:* Thin prompts eliminate drift and per-invocation payload cost without removing any Skill-owned safety obligation; the Skill is loaded before workflow execution and remains authoritative.
*Validity and invalidation conditions:* Valid for the current prompt-to-Skill authority graph and Issue #22 scope. A future invocation path that does not load the Skill must fail closed rather than restore duplicated workflow prose; any exception requires a later explicit owner decision.

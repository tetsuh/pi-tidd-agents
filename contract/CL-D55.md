## CL-D55 — A guard failure must name its failed subcheck
**Clauses:** CL-D55-addendum, CL-D55-tests

*Decision ID:* CL-D55
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#96` at its initial body, rule 2 only
*Question:* Is a batch-sequence guard failure that names no violated condition evidence that a boundary was violated?
*Options and trade-offs:* Option A requires every guard failure to name the violated condition and observed value, and classifies an unnamed failure as a guard-implementation defect — still terminal, but reported as what it is; Option B keeps accepting bare nonzero exits as boundary verdicts, which spends a whole run on a claim nobody can verify even post-mortem. The measured case for A: five PR #94 correction batches died at hand-rolled guards on 2026-08-30, and the worst of them exited 1 with empty stdout and stderr while every observable condition was healthy — the failing subcheck was unidentifiable after the fact.
*Recommendation:* Option A.
*Owner choice:* Option A. Every guard failure names the specific subcheck and the observed value; a failure with no named condition is a guard-implementation defect and its report says so while still carrying the read-only diagnostics the guard consulted. Terminality is unchanged: a true post-edit failure stays terminal with no retry or guard substitution, and an implementation-defect stop is terminal the same way.
*Rationale:* This is the reporting corollary of the existing principle that a check that cannot fail is not a check: a failure that cannot be named is not a finding. The rule changes what a failure report must contain, never what happens after a true failure, so it weakens no CL-D39 boundary; it converts unverifiable stops into diagnosable defect reports at zero authority cost. The packaged guard operations remain a separate decision (Issue #96 rule 1) because they grow the helper surface; this rule is deliberately prose-only so it can land first.
*Validity and invalidation conditions:* Applies to every guard and boundary check in Luna's batch sequence. It grants no retry, no guard substitution, no recovery, and no new authority. If the batch-sequence guards are later packaged as CLI operations whose failures name their predicate by construction, this rule is satisfied by that mechanism rather than invalidated.

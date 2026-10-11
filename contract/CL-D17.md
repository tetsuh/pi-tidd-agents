## CL-D17 — SonarCloud disposition
**Clauses:** CL-D17

The MVP has no SonarCloud credentials, so it cannot perform provider-side status transitions. It dispositions each finding, drafts the rationale, and hands it over. Readiness is never declared on the basis of a transition that was never performed. The packaged review-only driver has no SonarCloud path: a Sonar check reaches readiness as an ordinary check run or commit status, and no Accepted rationale is drafted; a gap recorded and not closed (#249, CL-D113).

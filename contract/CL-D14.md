## CL-D14 — Canonical status tokens
**Clauses:** CL-D14-issue, CL-D14-pr

`IMPLEMENTATION_READY`, `MERGE_READY`, `WAITING_EXTERNAL_REVIEW`, `WAITING_FOR_OWNER`, `ROUND_LIMIT_REACHED`, `BLOCKED`, `ABORTED`. `WAITING_FOR_OWNER` covers an owner action as well as an owner decision, rather than minting a token absent from #4's state list.

Readiness requires the approved artifact to be the published one. A run that drafted a revision, or left an unpublished candidate, ends at `WAITING_FOR_OWNER`: the gates approved something the target does not yet contain, and claiming readiness for content nobody else can see would be false.

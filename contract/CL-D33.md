## CL-D33 — Review-only drafts guarded owner-executed PR publication artifacts
**Clauses:** CL-D33-boundary, CL-D33-artifacts, CL-D33-marker, CL-D33-guards, CL-D33-post, CL-D33-portability, CL-D33-status, CL-D33-packaging

*Decision ID:* CL-D33
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#41` at the current Issue #41 body
*Question:* How can PR review-only offer safe owner publication of its aggregate review summary without acquiring publication authority itself?
*Options and trade-offs:* Keep manual copy-and-paste; let review-only post directly; or draft two external temporary artifacts with a fingerprint-bound owner-executed publisher. Manual copying is error-prone, direct posting violates the review-only boundary, and the bounded artifacts preserve non-mutation while making the owner grant explicit.
*Recommendation:* Adopt the Issue #41 guarded `review-comment.md` and `publish-review.sh` artifacts with one exact full-URL `gh pr comment` operation.
*Owner choice:* Implement the current Issue #41 contract: review-only drafts the artifacts but never executes or posts; the owner executing the printed Bash command supplies the publication grant.
*Rationale:* Constrained metadata, canonical visible-body and complete-artifact digests, exact target/head checks, complete paginated duplicate detection, one-shot POST behavior, and an external receipt make the later owner action explicit and fail closed without importing source-reply authority.
*Validity and invalidation conditions:* Applies only to PR review-only aggregate-summary publication artifacts. It never grants review-only direct provider mutation, Issue publication, source-finding replies, reviews, approvals, thread resolution, retries, reconciliation, or any autofix action. Any metadata, body, target, lifecycle, head, evidence, digest, POST, or receipt ambiguity stops the script; a later command is a fresh owner action. CL-D77 later extended the drafting of these artifacts to every exact-autofix terminal outcome whose repository, pull request, and public head are resolved, and strengthened the template's identity checks for both modes, under its own decision.

The implementation must preserve the exact `gh pr comment <full-pr-url> --body-file <review-comment.md>` operation, use complete UTF-8/LF bytes, and keep the template package-owned while `agents/**`, shared references, and exact autofix authority remain unchanged.

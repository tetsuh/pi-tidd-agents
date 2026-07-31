---
description: Review a GitHub pull request toward MERGE_READY through the closed-loop TiDD workflow; add the exact token autofix to permit file edits
argument-hint: "<pr-ref> [autofix]"
---

Run the closed-loop pull-request readiness workflow.

Raw arguments (preserve this complete vector for the Skill to parse): $@

Load the `closed-loop-pr` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt. The Skill parses the raw arguments, including two-token references such as `PR #123`, using the documented target and mode grammar (CL-D6).

Mode parsing is case-sensitive: only the final exact token `autofix` selects autofix; absent mode is review-only, and any near-miss or extra argument must stop and print usage. Review-only is the default (AC-REVIEW-ONLY). Unless the exact mode token `autofix` was selected: do not edit any file in the repository, do not change git state, do not commit or push, do not post to GitHub, and do not mutate any external service.

`autofix` permits the bounded public-head correction loop defined by the Skill: for each reviewed public head/gate result, one `luna-worker` correction batch may validate, create one normal commit, and make one non-force push; the parent may then post confirmed source-finding replies. The run-wide cap remains five successful correction pushes. It never authorizes merge, force-push, amend, rebase, history rewriting, Issue mutation, review approval, thread resolution, provider-side mutation, or aggregate summary posting. All identity, manifest, circuit-breaker, and fail-stop rules belong to the Skill.

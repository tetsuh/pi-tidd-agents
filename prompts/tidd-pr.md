---
description: Review a GitHub pull request toward MERGE_READY through the closed-loop TiDD workflow; add the exact token autofix to permit file edits
argument-hint: "<pr-ref> [autofix]"
---

Run the closed-loop pull-request readiness workflow.

Raw arguments (preserve this complete vector for the Skill to parse): $@

Load the `closed-loop-pr` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt. The Skill parses the raw arguments, including two-token references such as `PR #123`, using the documented target and mode grammar (CL-D6).

Mode parsing is case-sensitive: only the final exact token `autofix` selects autofix; absent mode is review-only, and any near-miss or extra argument must stop and print usage. Review-only is the default (AC-REVIEW-ONLY). Unless the exact mode token `autofix` was selected: do not edit any file in the repository, do not change git state, do not commit or push, do not post to GitHub, and do not mutate any external service.

`autofix` permits file edits only. Commits, pushes, review replies, and external updates still require the separate run-scoped publication grant defined in the skill.

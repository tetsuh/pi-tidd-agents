---
description: Review a GitHub pull request toward MERGE_READY through the closed-loop TiDD workflow; add the exact token autofix to permit file edits
argument-hint: "<pr-ref> [autofix]"
---

Run the closed-loop pull-request readiness workflow.

Target reference: ${1:-MISSING}
Mode token: ${2:-NONE}
Extra arguments (must be empty): ${@:3}

Load the `closed-loop-pr` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt.

If the target reference is `MISSING` or empty, stop and print usage `/tidd-pr <pr-ref> [autofix]`, then end the run.

Mode parsing (CL-D6) is exact and fails closed:

- mode token exactly `autofix`, case-sensitive → autofix mode;
- mode token `NONE` → review-only mode;
- any other mode token, or any extra argument → stop and print usage.

Review-only is the default (AC-REVIEW-ONLY). Unless autofix mode was selected: do not edit any file in the repository, do not change git state, do not commit or push, do not post to GitHub, and do not mutate any external service.

`autofix` permits file edits only. Commits, pushes, review replies, and external updates still require the separate run-scoped publication grant defined in the skill.

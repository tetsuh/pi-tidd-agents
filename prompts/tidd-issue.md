---
description: Drive a GitHub issue to IMPLEMENTATION_READY through the closed-loop TiDD workflow
argument-hint: "<issue-ref>"
---

Run the closed-loop issue-readiness workflow.

Target reference: ${1:-MISSING}
Extra arguments (must be empty): ${@:2}

Load the `closed-loop-issue` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt.

Before anything else:

- If the target reference is `MISSING` or empty, stop and print usage `/tidd-issue <issue-ref>`, then end the run.
- If any extra argument is present, stop and print the same usage.

This workflow is review-and-draft only. It never edits repository files, never changes git state, and never posts to GitHub without explicit approval for that specific action.

---
description: Drive a GitHub issue to IMPLEMENTATION_READY through the closed-loop TiDD workflow
argument-hint: "<issue-ref>"
---

Run the closed-loop issue-readiness workflow.

Raw arguments (preserve this complete vector for the Skill to parse): $@

Load the `closed-loop-issue` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt. The Skill parses the raw arguments, including two-token references such as `Issue #123`, using the documented target grammar and rejects extra arguments.

This workflow is review-and-draft only. It never edits repository files, never changes git state, and never posts to GitHub without explicit approval for that specific action.

---
description: Drive a GitHub issue to IMPLEMENTATION_READY through the closed-loop TiDD workflow
argument-hint: "<issue-ref>"
---

Run the closed-loop issue-readiness workflow.

Raw arguments (preserve this complete vector for the Skill to parse): $@

Load the `closed-loop-issue` skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt. The Skill parses the raw arguments, including two-token references such as `Issue #123`, using the documented target grammar and rejects extra arguments.

Under CL-D31, the `/tidd-issue <ref>` prompt and direct `/skill:closed-loop-issue <ref>` invocation are equivalent entrypoints. The Skill remains review-and-draft-only before candidate construction and outside the candidate-publication phase; only its exact same-session owner-gated candidate publication preview can open the bounded Issue 13 publication attempt. All workflow details, no-retry boundaries, and foreign-repository rules belong to the Skill.

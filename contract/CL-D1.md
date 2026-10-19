## CL-D1 — Gate verdicts are supplied by the caller, not by agent files
**Clauses:** CL-D1-issue, CL-D1-pr, CL-D1-issue-routing, CL-D1-issue-retry

`terra-oracle` has no verdict contract of its own, and the acceptance criteria require the existing agents to stay unchanged. The verdict line is therefore required through the invocation payload, and nothing under `agents/` is modified. CL-D35 approves one capability-reducing removal for Issue #49, which cannot move a verdict into an agent file, and grants no further permission. CL-D59 later renamed the agent files to role identities under its own widening. CL-D62 later added the convergence role file under its own widening. CL-D65 later added the self-validation sentence to the four reviewer bodies under its own widening. CL-D121 later narrowed the convergence body's gate sentence to the pull-request gates under its own widening. A missing or unparsable verdict is a tool-level failure: retry once, then report `BLOCKED`.

#310 later retired the Issue candidate route (CL-D123): the Issue driver owns the malformed-verdict relaunch, and the CL-D31 retry and CL-D32 expiry rules lapsed with the route.

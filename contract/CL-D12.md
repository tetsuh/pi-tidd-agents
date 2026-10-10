## CL-D12 — Round budgets are run-scoped
**Clauses:** CL-D12

This MVP keeps no state between invocations, so re-running resets every counter and the limit can be bypassed by re-running. Accepted; implementations must not add a state file to work around it, and every status block reports rounds used. CL-D110 later bounded the packaged review-only driver across runs, reading the pull request's earlier rounds rather than a state file (#259).

## CL-D12 — Round budgets are run-scoped
**Clauses:** CL-D12

This MVP keeps no state between invocations, so re-running resets every counter and the limit can be bypassed by re-running. Accepted; implementations must not add a state file to work around it, and every status block reports rounds used.

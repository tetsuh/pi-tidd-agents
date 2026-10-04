## CL-D98 — The Sol and Terra roles ship gpt-6.1-sol
**Clauses:** CL-D98-record, CL-D98-forward, CL-D98-tests

*Decision ID:* CL-D98
*Kind:* contract
*Target and revision:* `tetsuh/pi-tidd-agents#212` at its body, whose "Owner decision (2026-10-03)" section records the choice
*Question:* GPT-6.1 Sol is available on the `openai-codex` provider, and the owner's own settings have run every Sol and Terra role on it since PR #205. CL-D87 ships `gpt-6-sol`, so an environment without overrides runs the older model. Does the package default follow?
*Options and trade-offs:* Option A ships `gpt-6.1-sol` for the three roles that ship `gpt-6-sol`; it costs the same apart from cheaper cache reads, has the same context window, and lacks only an `off` thinking level the package never uses; `openai-codex` and `opencode` offer both models, and a provider that lists only `gpt-6-sol` needs the override the README describes. Option B keeps `gpt-6-sol` and leaves the newer model to each operator's overrides, so the default and the reviewed practice differ.
*Recommendation:* Option A.
*Owner choice:* Option A. `tidd-adversarial-reviewer`, `tidd-safety-reviewer`, and `tidd-drift-reviewer` ship `gpt-6.1-sol`; `tidd-convergence-reviewer` and `tidd-autofix-worker` keep `gpt-6-luna`, and every role keeps thinking `high`. The README role table, the workflow vocabulary record, and CL-D22's role list name it; CL-D87 stays as history with a forward note.
*Rationale:* The default should be the model the workflow is reviewed with; the owner's runs since PR #205 are that evidence.
*Validity and invalidation conditions:* Applies to the three agent definitions' `model` and the surfaces that name it. Agent overrides in an operator's settings still take precedence. Another model, a thinking change, or moving a Luna role requires a new owner decision.

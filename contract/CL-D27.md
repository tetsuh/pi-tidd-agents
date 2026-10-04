## CL-D27 — Target stability during a run
**Clauses:** CL-D27

The target identity is re-resolved before every gate invocation and must be unchanged; anything else stops the run without mutation, and nothing is cleaned or switched to make the check pass.

The rule was short while the review-only MVP performed no publication. CL-D30 exact PR `autofix` now supplies explicit edit, commit, push, reply, final-classification, and summary-approval phases; every phase is bound by complete target identity and stale-target safety.

## CL-D6 — Mode token parsing is exact and fails closed
**Clauses:** CL-D6-skill

The mode token is the final token of the raw argument vector, evaluated once the target reference has been recognised. Exactly `autofix` selects autofix; no remaining token means review-only; anything else stops with usage.

The original wording said "the argument immediately following the target reference", which held only while a reference was one token. `Issue #123` and `PR #123` are accepted forms, and positional binding split them so `#123` was read as the mode token and rejected — an explicitly accepted form did not work.

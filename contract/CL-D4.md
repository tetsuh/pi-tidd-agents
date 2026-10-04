## CL-D4 — Do not use `context.md` / `plan.md`
**Clauses:** CL-D4

The workers' `defaultReads` name those files, but creating them is a file mutation forbidden in review-only mode and they are not ignored by `.gitignore`. Everything is passed inline in the payload instead.

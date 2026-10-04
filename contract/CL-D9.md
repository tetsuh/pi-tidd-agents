## CL-D9 — Evidence-specific fingerprints
**Clauses:** CL-D9, CL-D9-roots, CL-D9-issue, CL-D9-pr

`issue_spec`, `pr_base`, `pr_tree`, `pr_diff`, `pr_commits` and `pr_head` are tracked separately so a change invalidates only what it affects. Digests are `sha256` over a defined byte serialisation, computed with a shell command and never estimated. API evidence collection is bracketed by fresh base/head reads, since independent calls are separate requests against a moving target.

An authoritative comment is one whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` and whose author is not a bot.

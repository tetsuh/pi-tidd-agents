## CL-D9 — Evidence-specific fingerprints
**Clauses:** CL-D9, CL-D9-roots, CL-D9-issue, CL-D9-pr, CL-D9-serialization, CL-D9-brackets

`issue_spec`, `pr_base`, `pr_tree`, `pr_diff`, `pr_commits` and `pr_head` are tracked separately so a change invalidates only what it affects. Digests are `sha256` over a defined byte serialisation, computed with a shell command and never estimated. API evidence collection is bracketed by fresh base/head reads, since independent calls are separate requests against a moving target.

An authoritative comment is one whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` and whose author is not a bot.

#249 later refused the foreign review-only path (CL-D111): the packaged driver computes the pull-request fingerprints from the local checkout, and no run collects them from the GitHub API alone.

#249 later trimmed the PR Skill to its dispatch (CL-D119): the pull-request fingerprints, their serialization and the capture brackets are read in the packaged driver and helpers, and the Skill's carry-forward across a metadata-only rewrite and its retry after a moved bracket lapsed with the prose path, since a moved target stops the run.

#310 later retired the Issue candidate route (CL-D123): the packaged Issue driver computes `issue_spec`, so the Issue Skill no longer carries the shell recipe for hashing it by hand.

## CL-D8 — Targets outside the current repository
**Clauses:** CL-D8, CL-D8-foreign

A foreign target may be reviewed in review-only mode, with evidence from the GitHub API and no checkout. Autofix refuses such a target.

#249 later refused a foreign pull request in both PR modes; the Issue workflow's rule is unchanged (CL-D111): the packaged driver refuses a head in another repository before any run, and no path reviews it from the GitHub API alone.

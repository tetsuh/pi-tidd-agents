## AC-DISPOSITION — Finding disposition ledger
**Clauses:** AC-DISPOSITION, AC-DISPOSITION-issue, AC-DISPOSITION-pr

Every actionable finding gets exactly one of `fixed`, `accepted-as-designed`, `deferred`, `duplicate`, `not-applicable`, `needs-owner-decision`, with the full record for each. The enumerations are pinned whole and scoped to their section: field names matched individually were satisfied by unrelated prose elsewhere in the file, so a record could lose a column silently.

#249 later trimmed the PR Skill to its dispatch (CL-D119): a PR finding record's fields are the packaged gate result schema's, and only a gate's finding is corrected, so a reviewer score, a severity label or a provider recommendation is never by itself a decision to change code; the PR Skill's owner approval for merging without required deterministic coverage lapsed with the prose path, since the workflow never merges.

#310 later retired the Issue candidate route (CL-D123), so the Issue finding record carries no candidate identity; `snapshotAssignment` stays required in the Issue record schema and names the local review draft.

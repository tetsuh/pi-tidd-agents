## AC-REVIEW-ONLY — Review-only is the default
**Clauses:** AC-REVIEW-ONLY-record

Without the exact `autofix` token, and before candidate construction or outside CL-D31, no file edits, no git-state changes, no commits or pushes, no posting to GitHub, no replies to review threads, and no external mutation. CL-D31 is the sole named Issue exception and does not alter PR review-only. #249 later moved this record's pin off `references/review-only.md` to this record (CL-D113); the packaged review-only driver names no writing operation, which `test/issue-196-review-driver-4.test.js` asserts.

#310 later retired the Issue candidate route (CL-D123): the Issue root publishes nothing.

## DEC-EXT-SNAPSHOT-001 — External observation resumes by re-fetching
**Clauses:** none — structural
*Decision ID:* DEC-EXT-SNAPSHOT-001
*Kind:* contract
*Target and revision:* #6 at `0f8bd00`
*Question:* CL-D24 and CL-D13 required a digest of observed external events so a resume could detect edits, while CL-D28 removed that byte-exact specification from this MVP.
*Options and trade-offs:* Define a canonical event serialization in the Skill; withdraw the digest and re-fetch on resume; or defer external resume until #4. Defining serialization repeats the under-specified prose machinery rejected by CL-D28, while deferring resume loses honest observation continuity.
*Recommendation:* Withdraw the digest and re-fetch current external evidence on every resumed or later run.
*Owner choice:* Withdraw the digest and re-fetch; external evidence is current-run-only and never carried across runs.
*Rationale:* The origin is the only value a resume cannot re-derive, but the latest event time and event content return from live data. The narrowed decision avoids provider-specific identity and serialization design in this MVP; unknown provider identity, timestamp, or head association remains non-passing.
*Validity and invalidation conditions:* Holds while the MVP reports rather than enforces the observation window and takes a fresh snapshot on every run. If #4 enforces timing or needs to distinguish edits from re-fetches, revisit this decision with code.

Its outcome is enforced by `CL-D24`. Renovating the record preserves the final amended choice from the authoritative #3 decision comment; the comment remains historical context and is not an additional source of current contract ownership.

---

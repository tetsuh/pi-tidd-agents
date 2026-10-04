## CL-D26 — The authoritative contract record lives in this file
**Clauses:** none — structural

`CL-D1` through `CL-D25` lived in one comment on #3, which closed when the implementation merged, and new obligations already had nowhere to go. Three contract changes had landed without a record by then.

The record is this file, kept out of `files` so it is a development record rather than package payload, with a test asserting that clauses and decisions stay in step. Keeping the record on an issue cannot be enforced by anything, and the gap was structural rather than an attention failure. The accepted trade-off is that a record inside the repository can be changed in the same commit as the thing it records; the consistency test is what compensates.

Enforced by `test/contract-record.test.js`, which is this decision. CL-D103 later split it: the record is CONTRACT.md's preamble and index followed by the record files under `contract/`, all kept out of `files`.

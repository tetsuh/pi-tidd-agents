## CL-D13 — Status block and resume
**Clauses:** CL-D13, CL-D13-issue, CL-D13-pr

Outside the CL-D31 candidate-publication phase, a legacy review run that stops emits a `tidd-status` block carrying the target, fingerprints, state, active gate, rounds, internal findings with dispositions, pending decisions, and the next permitted action. Resuming means pasting it back; fingerprints are revalidated and recomputed rather than trusted. During candidate construction and afterward in that phase, CL-D31 supersedes this status/resume rule: no resumable block is emitted or accepted.

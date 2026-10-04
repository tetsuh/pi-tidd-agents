## CL-D24 — External observation is per-run and never carried forward
**Clauses:** CL-D24

Before the first Sol invocation, take exactly one external-review snapshot for the current head; that snapshot is the observation origin. It is not polling and does not delay internal review. A later run takes its own snapshot and carries no external evidence or origin forward; the quiet-period and fifteen-minute policy are reported for the current run only.

External evidence is not carried across runs. A resumed or later run takes its own snapshot, reprocesses what it sees, and reports the window for that run's observation only. An undeterminable state is reported as unknown rather than complete. Findings the workflow raises itself do carry, since their identities are assigned here rather than by a provider.

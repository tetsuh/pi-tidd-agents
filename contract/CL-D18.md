## CL-D18 — External observation is reported, not enforced
**Clauses:** CL-D18

The two-minute quiet period and fifteen-minute window are policy the MVP reports against. It has no timers and must not busy-poll. A service with no reviews, comments or checks on the current head is *not detected*, never passed and never failed; an unknown state is never treated as success. CL-D100 later made external review best effort: the quiet period and the window are gone, and what the run observed is reported and never waited for.

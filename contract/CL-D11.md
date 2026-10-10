## CL-D11 — Round accounting
**Clauses:** CL-D11, CL-D11-review-only

A round is one completed gate invocation returning a parsable verdict. There are a maximum of three completed invocations per gate, per target, per run, and the passing round counts. A gate rerun caused by a fix consumes a round from that gate's budget; a later gate forcing a change to something an earlier gate approved reruns the earlier gate against its own budget. Tool, provider, startup, stale-target and unparsable-verdict failures do not consume one. On exhaustion, report `ROUND_LIMIT_REACHED` and request an owner decision before continuing. CL-D110 later bounded the packaged review-only driver across fresh runs of one pull request (#259).

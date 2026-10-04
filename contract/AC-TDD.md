## AC-TDD — Risk-based test-first policy and truthful provenance
**Clauses:** AC-TDD, AC-TDD-issue-quality-gate

Coverage is classified as pre-implementation behavioural RED, pre-implementation compile/contract RED, co-developed integration coverage, review-driven regression, or retrospective reproduction. RED evidence is never fabricated and history is never rewritten to simulate chronology.

The two pre-implementation classes are separated by what a test does, not by where its inputs come from: inspecting an artifact's content or structure is compile/contract; executing the thing being specified and observing what it does is behavioural, wherever that thing lives. Assertion polarity is irrelevant. This is written down because the call was got wrong four times, and because the first attempt at the rule was itself too broad — it separated the classes by input origin, which would misclassify a unit test importing a module from this repository.

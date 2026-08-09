# Shared records and test contract

This documentation-only reference is read by both workflow roots. It owns common record schemas, disposition vocabulary, and AC-TDD policy. Workflow-specific transport, publication, policy precedence, and deterministic-coverage approval remain in their owning files.

## Finding dispositions (AC-DISPOSITION)

Give every actionable finding **exactly one disposition**:

```text
fixed
accepted-as-designed
deferred
duplicate
not-applicable
needs-owner-decision
```

For each finding record the source gate, severity, the target evidence fingerprint it was raised against, candidate or revision identity when applicable, evidence, impact, exactly one disposition, rationale, revised passage or corrective change when the disposition is `fixed`, validation evidence that the revision resolves it, and the reply/status URL or an explicit pending transport assignment. Judge findings individually; a severity label is never by itself a decision to change the specification or implementation. Record the rationale for anything intentionally left unchanged.

Group reports into blockers, changes worth making now or fixes worth making now, optional improvements, pre-existing conditions or findings, and findings intentionally declined. A finding dispositioned `accepted-as-designed`, `deferred`, or `not-applicable` is **settled**; re-raising one requires new evidence, not a restatement. A finding that traces to no acceptance criterion is an out-of-scope improvement rather than a blocker and must be labelled that way.

## Owner decisions (AC-DECISION)

Pause for the owner on public contracts and APIs, architecture, scope, compatibility and risk trade-offs, policy exceptions, and ADR acceptance. Routine details already settled by an approved contract remain implementation judgments.

Ask **one question at a time**, with options and a recommendation. Record durable decisions as exactly this schema:

```text
Decision ID
Kind
Target and revision
Question
Options and trade-offs
Recommendation
Owner choice
Rationale
Validity and invalidation conditions
```

Workflow-specific language, pending-state status, posting/draft transport, CL-D31/CL-D32 behavior, and exact-autofix owner boundaries remain in the owning workflow files. The Issue Skill retains project/Issue/package policy precedence and the recorded-owner-exception rule. PR mode references retain the deterministic-coverage owner-approval duty.

## AC-TDD coverage and truthful provenance

Classify coverage backing each assertion or fix truthfully as one of:

```text
pre-implementation behavioral RED
pre-implementation compile/contract RED
co-developed integration coverage
review-driven regression
retrospective reproduction
```

Require a meaningful behavioral RED for deterministic bug fixes and for behavior exercisable through an existing test seam. Permit truthful co-development for integration scaffolding, new module bootstrapping, platform-only packaging checks, and review-driven regression coverage when a pre-implementation behavioral RED is impractical.

**Never fabricate RED evidence**, and **never rewrite history to simulate** a test-first chronology. The two pre-implementation classes are separated by what the test does, not by where its inputs come from. A test that **inspects an artifact's content or structure** — reading a file and checking for required or forbidden text, parsing frontmatter — is compile/contract RED. A test that **executes the thing being specified and observes what it does** is behavioural RED, and it stays behavioural when the thing it executes lives in this repository. **Assertion polarity is irrelevant**: `doesNotMatch` against a Markdown file is no more behavioural than `match` against one.

Package inclusion and platform-only archive checks may be truthful co-developed integration coverage. A regression added in response to review is review-driven regression. Never claim that a static fixture proves runtime model compliance with a read instruction.

# GitHub Copilot Instructions

## Pull request review

When reviewing a pull request, inspect the PR description before reviewing code.

A reviewable PR description must clearly answer:

- What problem does this PR solve?
- What behavior changes after merge?
- What does not change?
- Who or what workflow is affected?
- How was the change validated?
- What are the risks?
- How can the change be rolled back or mitigated?

Flag the PR when the description is vague, generic, or mostly implementation history.
Ask for a rewrite before deep code review when the description does not make the
merge decision obvious to a reviewer.

Prefer comments that identify the missing decision-critical detail. Do not ask for
business-sensitive details when a safe technical summary is enough.

Watch for these PR-description issues:

- missing problem statement;
- missing concrete behavior change;
- missing validation commands or evidence;
- missing risk or rollback section;
- irrelevant logs, chat history, or implementation chronology;
- claims such as "tested" without naming what was tested;
- sensitive business/customer data that should be summarized safely instead.

For code review, keep feedback actionable and scoped to behavior, safety,
compatibility, tests, and maintainability.

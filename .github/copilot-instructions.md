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

## Spec/code drift review

This repository is spec-governed. Use `.ravi/specs` and the related `CHECKS.md`
files as source-of-truth context when reviewing code. A capability's normative
behavior lives in `.ravi/specs/<domain>/<capability>/`:

- `SPEC.md` — intent, model, invariants (`MUST`/`SHOULD`), validation commands, failure modes;
- `CHECKS.md` — the verifiable checklist and regression scenarios;
- `WHY.md` — rationale and rejected alternatives;
- `RUNBOOK.md` — debug and remediation flow.

Prefer citing a spec invariant or a `CHECKS.md` item over inventing your own
expectation. A spec's `applies_to` frontmatter and `id` help you find the
capability that owns a changed file.

The most valuable thing to catch is **drift** between code and its governing
spec. Check both directions on every PR:

- **Code → spec/checks:** the diff changes behavior, a contract, or an interface,
  but the governing `SPEC.md`/`CHECKS.md` was not updated to match. Flag invariants
  the change now violates or leaves stale.
- **Spec/checks → code/tests:** a `SPEC.md` or `CHECKS.md` was edited (new or
  changed invariant/check), but the code and tests were not updated to satisfy it.

### Review checklist

Pay particular attention when a PR touches any of these:

- **Behavior or contract changes** — anything altering observable behavior an invariant depends on;
- **CLI / API / events / schemas / SDK / OpenAPI** — command shapes and outputs, HTTP routes, NATS topics and payloads, JSON/DB schemas, the generated SDK (`packages/ravi-os-sdk/`), and `openapi.json`; confirm the spec, generated artifacts, and consumers stay consistent;
- **Spec changes** — `.ravi/specs/**/SPEC.md` edits; confirm code and tests follow;
- **`CHECKS.md`** — confirm each check stays accurate and the diff satisfies it;
- **Tests** — confirm changed behavior has matching coverage and spec regression scenarios are still exercised;
- **Validation commands** — confirm the concrete commands a spec lists still apply.

Concrete validation commands to reference instead of generic advice:

- `bun run typecheck` and `bun run build` — repository gates;
- `bun run test`, or `bun test <path>` for a focused suite listed in a spec's Validation/CHECKS section;
- `bin/ravi specs get <spec-id> --mode full --json` — read a spec and its companions;
- `bin/ravi specs sync --json` — re-index specs after editing any `.ravi/specs/**` file;
- `bin/ravi specs get <spec-id> --mode checks --json` — read a spec's checks after editing its `CHECKS.md`.

### How to write drift findings

Keep findings actionable, concise, and scoped to this PR's diff — no generic
reminders unrelated to the change. For each finding include:

- **Affected spec or likely spec area** — the `spec-id` (e.g. `runtime/prompt-rules`), or the closest capability if uncertain;
- **Affected file or changed behavior** — the file/symbol or behavior in question;
- **Reason** — which invariant or check is at risk, and why the change conflicts with it;
- **Suggested fix** — the smallest concrete change (update code, spec, `CHECKS.md`, or add a test).

When uncertain, ask a verification question or suggest a specific check to run
instead of asserting an automatic blocker. Prefer a question plus a command
(e.g. "Does this change the session-key contract? If so, does the `sessions`
spec still hold — please run `bun test src/router/sessions.test.ts`.") over a
hard "must not merge."

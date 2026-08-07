---
id: cli/tag-rules
title: "Tag-rules agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - tag-rules
tags:
  - cli
  - tag-rules
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/tag-rules.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/tag-rules/engine.ts
  - src/plugins/internal/ravi-system/skills/tag-rules/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
## Intent

Make `ravi tag-rules` reliable for agent consumers under the agent-first
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy and compact discovery. The domain's only two writes — `tick --apply`
(bulk, every contact) and `evaluate --apply` (single target) — were BORN
dry-run-by-default: without `--apply` they are pure previews. That pre-existing
switch is the documented brake equivalent, so no op receives a new `--execute`
brake and the `--apply` flag MUST NOT be renamed.

## Invariants

1. With `--json`, every failure on a migrated error path MUST return the
   envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (unused here — the
   brake equivalent is `--apply`, whose absence returns a SUCCESSFUL preview,
   exit 0, by pre-existing design).
3. `tag-rules show` and `tag-rules evaluate` on an unknown rule id MUST exit 1
   with `TAG_RULE_NOT_FOUND` and up to 3 `suggestions` built ONLY from the
   rule registry already loaded by the command — never from an extra load.
4. An unknown contact target on `tag-rules explain` or `tag-rules evaluate`
   MUST exit 1 with `CONTACT_NOT_FOUND` and MUST NOT carry suggestions:
   contacts enforce contactScope inside their own domain and tag-rules cannot
   reproduce that visibility filter (`cli/chats` precedent), so the envelope
   only points to `ravi contacts list`.
5. `tag-rules tick` and `tag-rules evaluate` WITHOUT `--apply` MUST NOT write
   any tag (contacts DB and chat bindings untouched); with `--apply` the same
   invocation performs the write. `--apply` MUST NOT be renamed to
   `--execute`.
6. `tag-rules list` MUST accept `--fields a,b,c` for compact output (the
   projection applies to the JSON `rules` payload; text rendering stays
   unprojected).
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.
8. Reads (`list`, `show`, `validate`, `explain`) keep immediate behavior and
   are declared unbraked.
9. `tick` and `evaluate` MUST declare `CommandAccess.kind: "mutate"`, because
   their `--apply` branches write tags. This authorization classification is
   independent from the existing default-preview confirmation behavior.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| tick --apply | bulk tag write across ALL contacts | pre-existing `--apply` default-dry-run (equivalent; not renamed) |
| evaluate --apply | single-target tag write | pre-existing `--apply` default-dry-run (equivalent; not renamed) |
| list / show / validate / explain | reads | not braked (declared) |

No op in this domain received a NEW `--execute` brake: both writes already
default to preview, which is the exact protection the brake exists to provide.

## Official error cases

| case | code | exit |
|---|---|---|
| rule not found (show / evaluate registry) | `TAG_RULE_NOT_FOUND` + suggestions from the loaded registry | 1 |
| unknown contact target (explain / evaluate) | `CONTACT_NOT_FOUND` (no suggestions, scoped) | 1 |
| invalid rule files | `TAG_RULE_VALIDATION_FAILED` + path-free file summaries | 1 |
| invalid flag/arg (parser level) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/tag-rules/SKILL.md` teaches this
surface and carries the contract section (`## Contrato Do CLI`): error codes,
the `--apply` equivalence and the mutate authorization classification. The `contacts`
and `observers` skills only show `tag-rules list --json` (read-only, no flag
changed). The cron example `tick --apply --json` in the tag-rules skill stays
valid — `--apply` was intentionally not renamed. Daemon-side reactive
evaluation calls the engine directly (`runTagRulesForContact` from the
consumer), not through this CLI, so the CLI contract does not affect reactive
tagging.

## Validation

- `bun test src/cli/commands/tag-rules.test.ts` green (contract block plus the
  no-write dry-run proof), no new failures vs the `dev` baseline.
- `bun tsc --noEmit` clean for the touched files.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `tag-rules show
  nope --json` → `TAG_RULE_NOT_FOUND`, exit 1 with suggestions; `tag-rules
  tick --json` → contact tags unchanged; adding `--apply` applies; `tag-rules
  list --json --fields id,scope` narrows rules.

## Known Failure Modes

- `tick` and `evaluate` are authorized as `mutate` for every invocation,
  because `CommandAccess` is operation-scoped. Exact legacy read grants are
  handled by the [global compatibility
  migration](../SPEC.md#authorization-and-confirmation-are-different-controls).
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- The `CONTACT_NOT_FOUND` mapping depends on the engine throwing the literal
  prefix `Contact not found:` (`evaluateRulesForContact`); changing that
  message breaks the envelope silently.
- `evaluate --file <path>` keeps legacy behavior: unreadable files go through
  `fail()`, and an invalid rule body surfaces as a raw Zod parse error
  (declared pending).
- `validate` reports broken rule files via `process.exitCode = 1` with plain
  text, not an envelope — pre-existing surface, declared.

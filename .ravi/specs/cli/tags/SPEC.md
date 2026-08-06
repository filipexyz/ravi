---
id: cli/tags
title: "Tags agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - tags
tags:
  - cli
  - tags
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/tags.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Tags agent-first CLI contract

## Intent

Make `ravi tags` reliable for agent consumers under the agent-first contract
defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit taxonomy and
compact discovery. Tags are the unified labeling surface for every Ravi asset;
all of its mutations are unitary and reversible and the domain has NO
destructive op (there is no `tags rm`/`delete`), so this is a write domain with
ZERO braked ops — that absence is a decision of this spec, not an omission.

## Invariants

1. With `--json`, every failure on a migrated error path MUST return the
   envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (unused here — no braked
   op exists in this domain).
3. `tags show`, `tags set`, `tags attach` and `tags detach` on an unknown tag
   slug MUST exit 1 with `TAG_NOT_FOUND` and up to 3 `suggestions` built from
   real slugs/labels (`dbListTagDefinitions`) — including the paths where the
   DB layer throws (`dbUpdateTagDefinition` on set, `dbUpsertTagBinding` on
   attach) instead of returning null.
4. `tags attach` on an unknown tag MUST NOT write any binding.
5. No `tags` op is braked with `--execute`: `create` is additive, `set` is a
   property update reversible by setting the previous value back, and
   `attach`/`detach` are unitary binding writes that reverse each other. There
   is no bulk or destructive mutation on this surface. Any future destructive
   op (e.g. a `tags rm`) MUST ship with the dry-run + `--execute` brake.
6. `tags list` and `tags search` MUST accept `--fields a,b,c` for compact
   output. The projection applies to the JSON payload (`items` and its alias);
   the text rendering stays unprojected.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
8. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | additive definition; no state overwritten | not braked (declared) |
| set | single-property update, reversible by re-setting | not braked (declared) |
| attach | unitary binding upsert, reversed by detach | not braked (declared) |
| detach | unitary binding removal, reversed by attach (binding metadata/provenance is lost — accepted) | not braked (declared) |
| rm / delete | does not exist on this surface | n/a (future op MUST bring the brake) |

## Official error cases

| case | code | exit |
|---|---|---|
| tag not found (show / set / attach / detach) | `TAG_NOT_FOUND` + suggestions | 1 |
| binding not found on detach (tag exists) | legacy text `Binding not found ...` (declared) | 1 |
| invalid flag/arg (parser level) | pending — see Known Failure Modes | — |

## Internal consumers

There is NO dedicated `tags` skill in `src/plugins/internal/ravi-system/skills/`
— this is a registered gap of this wave. The surface is taught incidentally by
the `permissions` skill (`tags show`), the `contacts` skill and
`docs/ravi-tag-system-v0.md`. None of them teaches a flag changed by this wave
(no flag was renamed and no brake was added), so no consumer required a syntax
update. The `contacts` skill teaches `ravi tags define ...`, a command that
does not exist (`tags create` is the real op) — pre-existing doc bug, reported
but not edited here because that skill belongs to the contacts wave.

## Validation

- `bun test src/cli/commands/tags.test.ts` green (contract block included), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `tags show nope
  --json` → `TAG_NOT_FOUND`, exit 1 with suggestions; `tags attach nope
  --contact <id> --json` → exit 1 and `tags search --json` still empty;
  `tags list --json --fields slug,kind` narrows items.

## Known Failure Modes

- The `tags` domain is NOT listed in `AGENT_CONTRACT_DOMAINS`
  (`src/cli/index.ts`, frozen in this wave), so parser-level usage errors
  (unknown flag, missing argument) still exit with commander's default plain
  text instead of the `USAGE_ERROR` envelope + exit 2. Adding `"tags"` there is
  the one-line follow-up.
- `dbDeleteTagBinding` returns `false` both for an unknown tag and for a
  missing binding; `tags detach` disambiguates by calling
  `dbGetTagDefinition` after the failed delete. Removing that check regresses
  the unknown-tag path to the generic legacy text.
- `dbCreateTagDefinition` throws `Tag already exists: <slug>` on duplicates;
  `tags create` does not map it to an envelope yet (declared pending — the
  error surfaces through the legacy error path).
- Tag suggestions are built from the global definition list: tags carry no
  per-agent visibility scope today (unlike contacts). If tags ever become
  scoped, the suggestion source must be filtered like `cli/contacts` does.

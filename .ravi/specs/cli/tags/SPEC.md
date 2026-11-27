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
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy and
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
9. `tags doctor` is read-only: it MUST NOT write tag definitions, bindings
   or events (opening the Ravi DB runs the same schema bootstrap as any CLI
   command). It reports definitions with no current binding (detached ones
   included), orphan bindings (only for asset types whose table lives in the
   Ravi DB, sessions matched by name or key; the rest are listed as
   unchecked, never guessed), bound tags without a behavior consumer
   (observer rule; tag rule in apply or condition, in any slug spelling;
   permission profile, contact permission tag or chat tag that scopes a
   contact grant; list filters do not count), contacts whose tags
   materialize capabilities from registry bindings or the contact policy,
   break-glass first, and bindings from legacy mirrors with their rewrite
   churn. It also lists chat-scoped grants (one chat or a chat tag) whose
   profile carries capabilities, break-glass first; the grants are listed as
   stored, before the contact eligibility check the runtime applies; with no
   grant table it lists none and MUST NOT create the table.
   `--limit` (1..500, default 50; anything else is a usage error, exit 2)
   truncates every list section; `summary` counts are never truncated.
10. The two power sections of `tags doctor` (contacts with capabilities from
   tags, chat-scoped grants) name contact ids and the power each holds. They
   MUST be computed only for a caller that holds `admin:system:*`; `read:tags`
   alone is not enough. For any other caller the report says
   `power: "withheld"`, both sections are empty and their four `summary`
   counts are `null` (not `0`, which would read as "nobody has power").
   `power`, `chatGrantPower` and the two chat-grant counts are optional in
   the return contract, so a newer SDK still decodes a report from an older
   gateway.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | additive definition; no state overwritten | not braked (declared) |
| set | single-property update, reversible by re-setting | not braked (declared) |
| attach | unitary binding upsert, reversed by detach | not braked (declared) |
| detach | unitary binding removal, reversed by attach (binding metadata/provenance is lost — accepted) | not braked (declared) |
| doctor | read-only report | n/a (no write) |
| rm / delete | does not exist on this surface | n/a (future op MUST bring the brake) |

## Official error cases

| case | code | exit |
|---|---|---|
| tag not found (show / set / attach / detach) | `TAG_NOT_FOUND` + suggestions | 1 |
| binding not found on detach (tag exists) | `COMMAND_FAILED` with `Binding not found ...` | 1 |
| invalid flag/arg (parser level) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

There is NO dedicated `tags` skill in `src/plugins/internal/ravi-system/skills/`
— this is a registered gap of this wave. The surface is taught incidentally by
the `permissions` skill (`tags show`), the `contacts` skill and
`design/ravi-tag-system-v0.md`. None of them teaches a flag changed by this wave
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

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `dbDeleteTagBinding` returns `false` both for an unknown tag and for a
  missing binding; `tags detach` disambiguates by calling
  `dbGetTagDefinition` after the failed delete. Removing that check regresses
  the unknown-tag path to the generic legacy text.
- `dbCreateTagDefinition` throws `Tag already exists: <slug>` on duplicates;
  the shared handler boundary returns canonical `COMMAND_FAILED`, but there is
  no domain-specific duplicate-tag code yet.
- Tag suggestions are built from the global definition list: tags carry no
  per-agent visibility scope today (unlike contacts). If tags ever become
  scoped, the suggestion source must be filtered like `cli/contacts` does.

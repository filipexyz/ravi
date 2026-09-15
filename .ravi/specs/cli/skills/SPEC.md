---
id: cli/skills
title: "Skills agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - skills
tags:
  - cli
  - skills
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/skills.ts
  - src/cli/agent-contract.ts
  - src/skills/manager.ts
  - src/plugins/internal/ravi-system/skills/skills/SKILL.md
owners:
  - ravi-dev
status: draft
normative: true
---
# Skills agent-first CLI contract

## Intent

Make `ravi skills` reliable for agent consumers under the global agent-first
contract in [`../SPEC.md`](../SPEC.md). This domain classifies the concrete
operations and the conditional risk of `skills install`; it does not redefine
the global envelope, exit taxonomy, authorization or transport behavior.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the canonical
   envelope defined by the global CLI spec.
2. Exit codes MUST follow the global taxonomy: `0` success, `1` execution or
   entity failure, `2` usage error and `3` blocked by confirmation policy.
3. `skills show`, `skills grant` and the batch skill axis on an unknown skill
   MUST exit 1 with `SKILL_NOT_FOUND` and up to three suggestions from the
   universe actually searched (catalog or installed). `skills install` follows
   the resolution ordering in invariant 5.
4. `skills grant`, `skills inspect` and the batch agent axis on an unknown
   agent MUST exit 1 with `AGENT_NOT_FOUND` and up to three suggestions from
   real agent ids/names.
5. `skills install` is conditionally braked by the actual invocation:
   - an additive catalog or local-source install (`overwrite: false`) resolves,
     selects and installs immediately, returning exit 0 without `--execute`;
   - every unconfirmed Git-source install MUST return the confirmation dry-run
     (exit 3) before source resolution, discovery, selection or writing. Its
     exact plan fields are `sourceKind`, controlled `sourceLabel`,
     `selectionDeferred: true`, `overwrite` and `codexSync`;
   - catalog/local installs with `--overwrite` MUST perform safe lookup,
     discovery and selection before the brake, then return exit 3 before any
     write. Their exact plan fields are `sourceKind`, controlled `sourceLabel`,
     `skillCount`, `overwrite` and `codexSync`;
   - `sourceLabel` is a controlled enum equal to `catalog`, `local` or `git`.
     Raw URLs, paths, basenames/subpaths, destination/plugin paths, skill names
     and skill content MUST be absent from every plan;
   - Git not-found errors are evaluated only after confirmation with
     `--execute`, because Git selection is intentionally deferred. Catalog and
     local not-found errors, including overwrite invocations, remain exit 1
     before the exit-3 brake and before any write.
6. Every dry-run MUST cause zero effects. A Git dry-run performs no source
   resolution, discovery, selection, temporary clone, resource creation,
   destination write or Codex synchronization. A catalog/local overwrite may
   perform side-effect-free lookup, discovery and selection, but MUST NOT call
   the installation sink, synchronize Codex or mutate/create any resource.
7. `skills grant-batch` and `skills revoke-batch` keep their pre-existing
   `--dry-run` flag as the brake equivalent of this domain: preview counts,
   exit 0, no write. The flag MUST NOT be renamed and the ops MUST NOT gain a
   separate `--execute`; their helpAfter text is the teaching surface for this
   equivalence.
8. `skills list` and `skills who` MUST accept `--fields a,b,c` for compact
   output.
9. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
10. Unbraked writes (`sync`, `grant`, `revoke`, `grant-batch`, `revoke-batch`
    and additive catalog/local `install`) keep immediate-write behavior and
    MUST be described accurately in the shipped `skill-creator` skill.
11. Without `--json`, error output keeps the legacy text path while preserving
    the canonical exit code.
12. Install errors, `suggestedAction` and `suggestions` MUST NOT repeat the raw
    `--source`, its URL/path/basename/subpath or source content. Suggestions may
    contain only bounded visible skill identifiers from the universe already
    resolved at the permitted stage.

## Write classification (brake decision per invocation)

| invocation | actual effect | confirmation |
|---|---|---|
| install from catalog, additive | reversible local persistence from the bundled catalog | immediate, exit 0 |
| install from local source, additive | reversible local persistence from an explicit local source | immediate, exit 0 |
| install from Git, additive | remote source resolution and third-party code import | dry-run exit 3, then `--execute` |
| install with `--overwrite`, any source | replacement of an existing installed skill | dry-run exit 3, then `--execute` |
| sync | idempotent local re-materialization | immediate |
| grant / revoke | reversible visibility change | immediate |
| grant-batch / revoke-batch | bulk reversible visibility change | pre-existing `--dry-run`, exit 0 preview |

`skills install` remains `kind: "mutate"` with
`requiresConfirmation: true`: it always writes, but confirmation is decided
per invocation from source kind and overwrite intent.

## Official error cases

| case | code | exit |
|---|---|---|
| skill not found after the permitted resolution stage | `SKILL_NOT_FOUND` + suggestions | 1 |
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| Git install or overwrite without `--execute` | `WRITE_REQUIRES_EXECUTE` + source-appropriate minimal plan | 3 |

## Domain exceptions and ordering

- Catalog/local selection is safe to perform before an immediate additive
  write or overwrite brake, so an unknown selected skill fails with exit 1
  before exit 3 and without writing.
- A Git source may require network access and temporary resources merely to
  discover its contents. It therefore returns exit 3 before resolution; a
  later `SKILL_NOT_FOUND` is observable only on the confirmed invocation.
- Overwrite always needs confirmation before replacement. Catalog/local
  discovery is side-effect-free, so those sources are selected before the
  brake and expose only `skillCount`, never names or content.
- `grant-batch` and `revoke-batch` intentionally retain the earlier preview
  contract instead of gaining another confirmation spelling.

## Internal consumers

`src/plugins/internal/ravi-system/skills/skills/SKILL.md` (name:
`skill-creator`) teaches the conditional install surface: additive
catalog/local examples run directly, while Git and overwrite examples carry
`--execute` or explicitly demonstrate the exit-3 preview.
`docs/reference/skills.mdx` mirrors the same classification. The helpAfter of
`grant-batch`/`revoke-batch` documents the `--dry-run` equivalence in place.

## Validation

- `bun test src/cli/commands/skills.test.ts` MUST pass before this spec is
  promoted from `draft`; existing tests remain because this file also backs
  the `src/router/` coverage gate.
- Focused checks MUST cover every branch of the real predicates (`sourceKind ===
  "git"`, `overwrite === true`, `execute === true`) with representative
  controls for additive catalog/local, unconfirmed Git, unconfirmed
  catalog/local overwrite and confirmed execution.
- The unconfirmed Git control MUST demonstrate that resolution is not reached.
  Catalog/local overwrite controls MUST demonstrate safe selection before the
  brake and installation/Codex sync only after confirmation.
- Live checks use isolated `RAVI_STATE_DIR`, `HOME` and `USERPROFILE` and expect
  additive catalog/local exit 0, unconfirmed Git exit 3 with
  `selectionDeferred: true`, and catalog/local overwrite exit 3 with a
  `skillCount`. Braked invocations install only with `--execute`.

## Known Failure Modes

- A static brake before classifying the invocation adds an unnecessary second
  call to additive catalog/local installs.
- Resolving or discovering a Git source before the brake can perform network
  or temporary-file work before the operator confirms.
- `selectSkills` throws plain errors rather than returning null. Additive
  and overwrite catalog/local installs map that result before any write. Git
  invocations MUST NOT call it before the exit-3 brake; their not-found mapping
  occurs only after `--execute` and after resolved-source cleanup.
- `installSkills` resolves its destination from `homedir()` with no CLI
  override, so execute-path tests redirect `HOME`/`USERPROFILE` to a temporary
  directory and assert the redirect before any write.

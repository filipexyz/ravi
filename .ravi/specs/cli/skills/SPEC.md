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
status: active
normative: true
---
# Skills agent-first CLI contract

## Intent

Make `ravi skills` reliable for agent consumers under the agent-first contract
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write
brake on the riskiest mutation, and compact discovery. This domain governs what
other agents can DO (per-agent skill visibility via grants), and `install`
copies third-party code into the operator environment — that is the braked op.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `skills show`, `skills grant`, `skills install` and the batch skill axis on
   an unknown skill MUST exit 1 with `SKILL_NOT_FOUND` and up to 3
   `suggestions` from the universe actually searched (catalog, installed, or
   the `--source` being inspected).
4. `skills grant`, `skills inspect` and the batch agent axis on an unknown
   agent MUST exit 1 with `AGENT_NOT_FOUND` and up to 3 `suggestions` from
   real agent ids/names.
5. `skills install` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and an exact metadata-only `plan` with
   `sourceKind`, path-basename-only `sourceName`, `skillCount`, `overwrite`
   and `codexSync`. It MUST NOT carry raw source/destination paths, plugin
   bucket paths, skill names or skill content, and MUST NOT copy anything.
   Not-found validation MUST fire BEFORE the brake (exit 1, never 3).
6. `skills grant-batch` and `skills revoke-batch` keep their PRE-EXISTING
   `--dry-run` flag as the brake equivalent of this domain: preview counts,
   exit 0, no write. The flag MUST NOT be renamed and the ops MUST NOT gain a
   separate `--execute` — the didactic helpAfter of both commands is the
   canonical teaching surface for this equivalence.
7. `skills list` and `skills who` MUST accept `--fields a,b,c` for compact
   output.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
9. Unbraked writes (`sync`, `grant`, `revoke`, `grant-batch`, `revoke-batch`)
   keep immediate-write behavior and MUST be declared as unbraked in the
   shipped `skill-creator` skill.
10. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| install | third-party code enters the environment (high) | dry-run + `--execute` |
| sync | re-materializes what already exists locally; idempotent | not braked (declared) |
| grant / revoke | reversible pair, live effect | not braked (declared) |
| grant-batch / revoke-batch | bulk reversible pair | pre-existing `--dry-run` (equivalent; kept, not renamed) |

## Official error cases

| case | code | exit |
|---|---|---|
| skill not found | `SKILL_NOT_FOUND` + suggestions | 1 |
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/skills/SKILL.md` (name:
`skill-creator`) teaches this surface and MUST carry `--execute` on every
install example. `docs/reference/skills.mdx` mirrors the same examples. The
helpAfter of `grant-batch`/`revoke-batch` documents the `--dry-run` brake
equivalence in place.

## Validation

- `bun test src/cli/commands/skills.test.ts` green (contract block included),
  no removed tests — this file also backs the `src/router/` coverage gate.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `skills install
  agents-manager --json` → exit 3 + plan, nothing under the plugin bucket;
  with `--execute` → installed; `skills show <bad-name> --json` →
  `SKILL_NOT_FOUND`, exit 1; `skills grant <bad-agent> <skill> --json` →
  `AGENT_NOT_FOUND`, exit 1; `skills list --fields name,source --json` narrows
  items.

## Known Failure Modes

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `selectSkills` throws plain errors ("Skill not found: ...") instead of
  returning null; mapping must catch the throw or the envelope never fires
  (`surveyInstallSelection` covers it) — and the mapping must happen OUTSIDE
  `withResolvedSkillSource` so temp git clones are cleaned up before the
  process exits on brake/not-found.
- `installSkills` writes under `homedir()`; tests that execute a real install
  MUST redirect `HOME`/`USERPROFILE` to a temp dir and fail fast if the
  runtime does not honor the redirect.

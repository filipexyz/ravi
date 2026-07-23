---
id: apps/cli
title: "Ravi CLI Apps"
kind: capability
domain: apps
capabilities:
  - cli
  - context-key
  - json-contract
  - storage
  - skill-operation
tags:
  - apps
  - cli
  - commander
  - context-key
  - agent-first
applies_to:
  - src/cli
  - src/cli/commands
  - src/cli/registry.ts
  - src/cli/registry-snapshot.ts
  - src/utils/pagination.ts
  - src/plugins/internal/ravi-dev/skills/cli-creator
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi CLI Apps

## Intent

Define when a CLI should be treated as a Ravi App and how it connects to the
Ravi OS application ecosystem.

A CLI App is not just an executable. It is a domain application whose primary
interface is a CLI and whose behavior is safe for agents to operate through
stable commands, machine-readable output, context-key authorization, and a
teaching skill.

## Invariants

- A Ravi-owned CLI App MUST use `bun + commander` unless a domain spec grants
  an explicit exception.
- A CLI App MUST start from domain modeling: problem, decision, entities,
  artifacts, lineage, persistence, and recovery. It MUST NOT start from parser
  shape.
- A CLI App MUST expose concrete verbs such as `list`, `show`, `create`,
  `update`, `delete`, `sync`, `check`, or `run`. Vague verbs such as `do`,
  `process`, `handle`, or `misc` SHOULD NOT be used.
- Machine-consumed commands MUST support `--json`.
- List commands that can grow MUST follow the CLI listing contract: bounded by
  default, include pagination/page metadata, and show a next command or cursor
  when more data exists.
- List/show/check commands that disclose app manifests or installed app ids
  MUST filter by app visibility under runtime context.
- Commands MUST return or print enough structured information for an agent to
  decide the next step without scraping prose.
- Errors MUST explain what failed, why it failed, and how to correct it.
- A CLI App that runs inside Ravi runtime MUST receive `RAVI_CONTEXT_KEY` and
  resolve identity through `ravi context whoami`, `ravi context check`, or
  `ravi context authorize`.
- A CLI App MUST NOT print raw context keys, secrets, or bearer tokens.
- A CLI App MUST declare least-privilege capabilities for sensitive actions.
  It MUST NOT rely on broad inherited permission unless the launcher explicitly
  needs `--inherit` and documents why.
- Stateful CLI Apps SHOULD use domain-specific SQLite storage when persistence
  adds reuse, lineage, audit, cache value, or durable asset tracking.
- If a CLI App persists artifacts, it SHOULD store normalized input, output,
  metadata, hash, version, dependencies, source, and timestamps where useful.
- The skill for a CLI App MUST be a teaching layer. It MUST NOT hide missing
  CLI behavior by asking the agent to improvise around weak commands.
- First-party Ravi CLI Apps that live in `src/cli/commands` SHOULD use the
  decorator registry so the same command surface can feed the CLI, SDK gateway,
  OpenAPI, and generated clients.
- CLI Apps with streaming or interactive operations MUST NOT expose those
  operations through the single-shot SDK dispatcher. Use `@CliOnly()` or a
  dedicated stream/control channel.
- CLIs that are intended to be imported into Ravi Apps SHOULD expose a safe
  self-description command such as `manifest --json`, `app-manifest --json`, or
  `ravi manifest --json`.
- CLI self-description MUST be deterministic, side-effect free, and sufficient
  for `apps/import-cli` to identify commands, args, options, JSON support,
  mutation risk, examples, and safe health checks without scraping human prose.

## Design Flow

Before implementation, answer these in order:

1. What manual, diffuse, or hard-to-audit work does this app replace?
2. What decision becomes easier after the app exists?
3. What entities and relationships exist in the domain?
4. What artifacts does the app produce?
5. What must be recoverable later?
6. What must be audit-friendly?
7. What is deterministic and reusable?
8. What changes enough to require versioning or migration?

Only after those answers should the command surface be designed.

## Command Surface

CLI App commands SHOULD expose:

- predictable names;
- good help text with real examples;
- `--json` for machine use;
- explicit `--dry-run` for destructive or broad operations when practical;
- bounded defaults for reads;
- clear next-step hints in human output.

For first-party Ravi commands, decorators SHOULD carry the machine contract:

- `@Group` for stable domain namespace;
- `@Command` for operation name and description;
- `@Arg` and `@Option` for input shape;
- explicit Zod `schema` when default string/boolean inference is too weak;
- `@Returns(zod)` for SDK-facing return shape;
- `@Returns.binary()` only for raw response bodies;
- `@CliOnly()` for process, interactive, or streaming operations.

## Runtime Context

For app launchers that call a CLI from inside Ravi:

1. The parent SHOULD issue a child context with `ravi context issue`.
2. The child process SHOULD receive only `RAVI_CONTEXT_KEY`.
3. The app SHOULD resolve identity with `ravi context whoami`.
4. The app SHOULD check or request specific capability with `ravi context check`
   or `ravi context authorize`.
5. Audit lineage SHOULD preserve `parentContextId`, `issuedFor`, source, and
   the concrete command/action performed.

Legacy env vars may exist for compatibility, but they are not the app contract.

## Validation

- `ravi specs get apps/cli --mode rules --json` MUST return this contract.
- New first-party CLI App commands SHOULD be covered by command tests and, when
  SDK-facing, by registry/codegen/gateway tests.
- CLIs with app-import ambitions SHOULD include tests for their self-description
  JSON contract.
- `bun run gen:commands` SHOULD include new `src/cli/commands/*.ts` files in
  the generated barrel.
- `bun run sdk:check` SHOULD remain clean when SDK-facing command metadata is
  changed and regenerated.
- List commands SHOULD be checked for bounded defaults and machine-readable
  pagination/page metadata.
- App discovery commands SHOULD be checked under runtime context to ensure
  hidden apps are omitted and direct lookups use a not-found-equivalent error.

## Known Failure Modes

- Parser-first CLIs produce commands that are easy to invoke but hard to use.
- Human-only output makes agents brittle and causes regex scraping.
- Unbounded list defaults can stall agent turns or daemon-side gateway calls.
- Missing `@Returns` turns SDK output into `unknown` and weakens app clients.
- External CLIs that use session env vars instead of `RAVI_CONTEXT_KEY` lose
  least privilege and lineage.
- CLIs without self-description force `apps/import-cli` into low-confidence
  help parsing.
- A skill that tells agents to "figure it out" instead of exposing a reliable
  CLI app surface hides product debt.
- Stateful apps sharing generic storage create unclear ownership and migration
  risk.

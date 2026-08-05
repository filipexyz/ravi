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

Define the executable contract for every Ravi App and how the app CLI connects
to Ravi OS.

A Ravi App is a domain CLI with stable commands, explicit machine output when
needed, context-key authorization, and a teaching skill. The app can also run
standalone when its domain permits, but Ravi-launched execution always uses a
delegated child context.

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
- A CLI command's transport contract is argv, optional documented stdin,
  stdout, stderr, and exit status.
- Ravi MUST launch declared App CLI commands as executable plus argv with no
  shell evaluation. User-provided arguments MUST remain separate literal argv
  elements.
- `--json` MUST mean machine-readable command output only. It MUST NOT define a
  separate App host protocol, callback protocol, or JSON-RPC transport.
- A CLI App launched by Ravi MUST receive a fresh child `RAVI_CONTEXT_KEY` and
  resolve identity through `ravi context whoami`, `ravi context check`, or
  `ravi context authorize`.
- A CLI App MUST use ordinary public `ravi ...` commands when it needs Ravi
  services. It MUST NOT depend on private runtime imports or reconstruct a Ravi
  client protocol.
- A CLI App MUST NOT print raw context keys, secrets, or bearer tokens.
- A CLI App MUST declare least-privilege capabilities for sensitive actions.
  The launcher MUST derive the child ceiling from manifest `context.allow`.
- `--inherit` MUST NOT be the default launch mode. Any exception MUST be
  explicit, reviewed, and documented outside the app manifest.
- Stateful CLI Apps SHOULD use domain-specific SQLite storage when persistence
  adds reuse, lineage, audit, cache value, or durable asset tracking.
- If a CLI App persists artifacts, it SHOULD store normalized input, output,
  metadata, hash, version, dependencies, source, and timestamps where useful.
- The skill for a CLI App MUST be a teaching layer. It MUST NOT hide missing
  CLI behavior by asking the agent to improvise around weak commands.
- A first-party App CLI MAY be implemented as a registered static Ravi command
  under `src/cli/commands` and use the decorator registry for its command
  contract. App-facing UI, SDK, tool, and automation callers MUST still enter
  through the generic App Router; decorator metadata MUST NOT become a second
  App operation executor.
- CLI Apps with streaming or interactive operations MUST NOT expose those
  operations through a single-shot caller. They remain CLI operations and
  SHOULD use `@CliOnly()` or a TTY/stream-capable launcher.
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

For a first-party App CLI implemented as a static Ravi command, decorators
SHOULD carry the CLI machine contract:

- `@Group` for stable domain namespace;
- `@Command` for operation name and description;
- `@Arg` and `@Option` for input shape;
- explicit Zod `schema` when default string/boolean inference is too weak;
- `@Returns(zod)` for SDK-facing return shape;
- `@Returns.binary()` only for raw response bodies;
- `@CliOnly()` for process, interactive, or streaming operations.

Generated SDK/OpenAPI metadata for the underlying static command is a
compatibility surface of Ravi CLI. It MUST NOT replace App Router authorization
or be referenced as an independent App executor in `ravi.app.json`.

## Runtime Context

For app launchers that call a CLI from inside Ravi:

1. The router MUST authorize the caller against `app:<app-id>`.
2. The router MUST issue a fresh child context with stable
   `cliName: "app:<app-id>"`, explicit capabilities from `context.allow`, and a
   bounded TTL.
3. The router MUST fail before process spawn if any required child capability
   cannot be issued.
4. The launcher MUST build an allowlisted child environment, removing the
   parent `RAVI_CONTEXT_KEY`, legacy Ravi identity variables, and unrelated
   credentials or secrets before setting the child `RAVI_CONTEXT_KEY`.
5. The child process MUST receive the child key as its only Ravi identity
   credential. Normal non-secret process environment such as `PATH` MAY remain.
   The process MUST run from the bounded app/package root and without a shell.
6. The app MUST resolve identity with `ravi context whoami`.
7. The app MUST use `ravi context check` or `ravi context authorize` before a
   Ravi action whose capability is not already known.
8. The app performs the action through the ordinary Ravi CLI, for example
   `ravi artifacts create`, `ravi sessions read`, or another public command.
9. Audit lineage MUST preserve the child context id, `parentContextId`,
   `issuedFor`, issuance mode, source app/operation, and result without storing
   the raw key.

Legacy env vars may exist for compatibility, but they are not the app contract.
The router MUST NOT synthesize them for App execution.

## Surface Adapters

- The generic App Router MAY be called from CLI, UI, SDK, runtime tool, or
  automation surfaces.
- All adapters MUST resolve the same app operation and launch the same app CLI.
- An adapter MAY request JSON output for its own consumption. That does not
  change the App-to-Ravi integration model.
- App manifests MUST NOT require separate SDK, tool, or stream executors for
  the same operation.

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
- Launchers that reuse the parent context key turn the app into a privilege
  escalation surface.
- Launchers that use a shell or inherit the full parent environment expose
  command injection and credential leakage.
- Separate SDK/tool implementations drift from the CLI and multiply auth paths.
- Treating JSON output as a transport protocol adds a contract that process
  execution already provides.
- CLIs without self-description force `apps/import-cli` into low-confidence
  help parsing.
- A skill that tells agents to "figure it out" instead of exposing a reliable
  CLI app surface hides product debt.
- Stateful apps sharing generic storage create unclear ownership and migration
  risk.

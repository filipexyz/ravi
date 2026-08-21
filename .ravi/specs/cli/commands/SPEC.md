---
id: cli/commands
title: "Ravi Commands agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - commands
tags:
  - cli
  - commands
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/commands.ts
  - src/cli/commands/operational-return-schemas.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/commands/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
## Intent

Make `ravi commands` reliable for agent consumers across `list`, `show`,
`validate`, and `run`. The surface uses typed error envelopes, the 0/1/2/3
exit taxonomy, bounded pagination, strict compact fields, and declared return
schemas.

The whole domain is read-only. `run` only renders a composed prompt preview;
it never publishes to a session or starts runtime execution. Therefore no
COMMANDS operation has a write brake or a valid exit-3 path.

## Invariants

1. With `--json`, every failure MUST return
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?|acceptedFields?}}`.
2. Exit codes MUST follow the shared taxonomy: `0` success, `1` execution or
   lookup failure, `2` usage failure, and `3` policy block. COMMANDS MUST NOT
   emit exit 3.
3. `show` and `run` with a valid but absent name MUST exit 1 with
   `COMMAND_NOT_FOUND` and suggestions from the same registry used by lookup.
4. `show` and `run` with an empty or syntactically invalid name MUST fail
   before agent resolution with `INVALID_COMMAND_NAME`, exit 2, and a safe
   correction hint. They MUST NOT become `UNHANDLED_ERROR`.
5. After name validation, an unknown `--agent` MUST exit 1 with
   `AGENT_NOT_FOUND` and suggestions from the read-only agent directory
   snapshot before command discovery starts.
6. `list` MUST reject non-integer, zero, negative, fractional, or over-limit
   pagination as `USAGE_ERROR`, exit 2. `limit` is 1 through 500; `offset` is
   an integer of zero or greater.
7. `list --fields` MUST project the same rows into both `items` and `commands`.
   One unknown field invalidates the complete request as `USAGE_ERROR`, exit
   2, with stable `acceptedFields`, including when the result is empty. It
   MUST NOT return `{}` rows with exit 0.
8. The stable list fields are `id`, `token`, `title`, `description`,
   `argumentHint`, `arguments`, `disabled`, `scope`, `path`, `relativePath`,
   `shadowedBy`, `shadows`, and `issues`. Handler, return schema, generated
   surface, and this spec MUST remain coherent with this set.
   A compact projection MUST serialize as exactly the requested non-empty
   subset and its published schema MUST accept that JSON without hidden
   properties.
9. `validate` keeps its pre-existing exit-1 verdict through
   `process.exitCode` when command files contain errors. That is a validation
   result, not a contract error envelope.
10. Repeating an operation against unchanged files and config MUST preserve
    JSON values, ordering, pagination continuation, and rendered prompt hash.
11. `list`, `show`, `validate`, and `run` MUST leave command files, every
    SQLite table, every durable runtime state file (including `ravi.db` and its
    WAL), and runtime transport unchanged. A read MAY update SQLite's ephemeral
    `-shm` coordination index while a writer is active; that index is not
    durable command or route state. Reads MUST remain current under concurrent
    WAL writers, MUST resolve agents without schema initialization or writable
    SQLite access, and MUST NOT emit command audit transport events.
    The audit opt-out policy MUST reject any operation that is not a low-risk
    read with resolved effect class `none`.
12. A thrown `ContractError` MUST preserve its exit code through CLI, tool,
    gateway, and agent-context dispatchers.
13. Invoking bare `ravi commands` MUST print the group help and exit 0. It is
    discovery, not a failed operation.

## Operation Contract

| operation | behavior | effect class |
|---|---|---|
| bare group | print operation discovery help | read |
| `list` | discover, filter, paginate, and project command summaries | read |
| `show` | resolve and return one command, including its body | read |
| `validate` | classify registry issues and return a verdict | read |
| `run` | render and return a composed prompt preview | read |

`run` is a renderer despite its name. It does not publish to
`SESSION_PROMPTS`, dispatch a provider request, mutate a session, or execute
Markdown content.

## Official Error Cases

| case | code | exit |
|---|---|---|
| command not found | `COMMAND_NOT_FOUND` plus suggestions | 1 |
| agent not found | `AGENT_NOT_FOUND` plus suggestions | 1 |
| empty or invalid command name | `INVALID_COMMAND_NAME` | 2 |
| invalid `--limit` or `--offset` | `USAGE_ERROR` | 2 |
| unknown `--fields` value | `USAGE_ERROR` plus `acceptedFields` | 2 |
| invalid flag or positional argument | `USAGE_ERROR` plus parser metadata | 2 |
| validation errors present | pre-existing validation verdict | 1 |

## Compatibility

The following behavior is deliberately preserved:

- command names remain case-insensitive and accept an optional leading `#`;
- `items` and `commands` remain redundant aliases with equal rows;
- valid `--fields` projections remain compact;
- `validate` keeps its exit-1 file verdict;
- `run` keeps `renderedPromptSha256` and remains preview-only.
- bare `ravi commands` now returns successful discovery help instead of the
  legacy exit 1.

Strict fields are a deliberate hardening. Legacy COMMANDS silently ignored an
unknown field, which could return partial data or `{}` with success. The whole
request now fails so a typo cannot masquerade as valid empty data.

## Boundary

This contract owns the existing four CLI operations. The conversational
facade proposed in the domain dossier remains deferred until registry
revision, envelope integrity, engine routing, real shadowing, and
material-change contracts are decided.

## Internal Consumer

`src/plugins/internal/ravi-system/skills/commands/SKILL.md` teaches this
surface. It MUST describe name validation, pagination, strict fields, exit
taxonomy, and the absence of write effects.

## Validation

- `bun test src/cli/commands/commands.test.ts` covers every operation, typed
  usage failures, schema acceptance, determinism, and unchanged source state.
- `bun test src/commands/index.test.ts` covers registry and renderer behavior.
- SDK generation/check, typecheck, build, quality gate, and documentation lint
  are proportional release gates for a surface or schema change.

## Known Failure Modes

- A raw `RaviCommandError("invalid_command_name")` is an engine detail. The
  CLI boundary must translate it before the unexpected-error fallback.
- COMMANDS must not catch and recode the shared pagination
  `CliExpectedError`.
- Omitting the stable field set from `pickFields` restores legacy silent
  projection behavior.
- Return schema changes without regenerated surfaces create tool and SDK
  drift even when direct CLI calls still work.
- A return schema that validates complete non-enumerable properties before
  JSON serialization is invalid; only the serialized public projection counts.
- Opening the normal config store for discovery can initialize SQLite or alter
  WAL/SHM files even when table rows are unchanged.
- Bare-help behavior is opt-in through group metadata; enabling it globally
  would change unrelated domains and is outside this contract.

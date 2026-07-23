---
id: tools/registry
title: "Tools Registry"
kind: capability
domain: tools
capability: registry
capabilities:
  - search
  - discovery
  - safe-test
  - explicit-execution
tags:
  - tools
  - registry
  - search
  - safety
applies_to:
  - src/cli/commands/tools.ts
  - src/cli/tool-definitions.ts
  - src/cli/tools-export.ts
  - src/cli/registry-snapshot.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Tools Registry

## Intent

The tools registry is the source-of-truth for all CLI commands exposed as SDK
tools. Discovery surfaces (search, list, show, manifest, schema) read from the
registry without executing handlers.

## Discovery

### Search

`ravi tools search <query> [--limit <n>] [--json]`

- Matches against: name, full command, group, command, description, parameters,
  command access metadata, and skill gate metadata.
- Uses simple deterministic term-matching ranking. No LLM, no network, no
  embeddings.
- Default limit MUST be bounded (10).
- JSON output MUST include: `query`, `limit`, `total`, `items[]` with rank/score
  and `matchedFields` per item.
- Human output MUST show compact top matches and useful next commands:
  `ravi tools show <name>`, `ravi tools test <name> <args-json> --json`,
  `ravi tools invoke <name> <args-json> --json`.

### List, Show, Manifest, Schema

These commands are read-only discovery surfaces. They MUST NOT call
`tool.handler`. Their behavior is unchanged from the existing contract.

## Safe Test (Dry-Run)

`ravi tools test <name> [args-json] [--json]`

- MUST NOT call `tool.handler`.
- MUST validate the tool exists.
- MUST parse and normalize args.
- MUST return mode `dry_run` (or `executed: false`).
- MUST show schema, access metadata, target metadata.
- MUST show the explicit execution command.

## Explicit Execution

`ravi tools invoke <name> [args-json] [--json]`

- Calls the existing handler path.
- Preserves existing enforcement: command access, scope, skill gate, runtime
  authorization.
- Returns mode `executed`.
- Annotated with `@CommandAccess({ kind: "mutate", resource: "tools", action: "invoke", risk: "high" })`.
- MUST NOT be a bypass of any authorization layer.

## JSON Shapes

### Search Result Item

```json
{
  "rank": 1,
  "score": 3,
  "name": "sessions_send",
  "description": "Send a message to a session",
  "group": "sessions",
  "command": "send",
  "matchedFields": ["name", "description"]
}
```

### Dry-Run Test Result

```json
{
  "mode": "dry_run",
  "executed": false,
  "tool": { "name": "...", "description": "...", "metadata": {} },
  "args": {},
  "schema": {},
  "access": {},
  "invokeCommand": "ravi tools invoke <name> '{}' --json"
}
```

### Invoke Result

```json
{
  "mode": "executed",
  "executed": true,
  "tool": { "name": "...", "description": "...", "metadata": {} },
  "args": {},
  "result": { "isError": false, "content": [] }
}
```

## Acceptance

- `ravi tools search "send message" --json --limit 5` returns parseable JSON.
- Search never calls `tool.handler`.
- `ravi tools test <name> <args-json> --json` does not execute handlers.
- `ravi tools invoke <name> <args-json> --json` executes handlers.
- `tools invoke` does not bypass command access/scope/skill gate.
- New commands have concrete return schemas.

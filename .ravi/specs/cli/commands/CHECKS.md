# Ravi Commands agent-first CLI contract / CHECKS

## Contract Checks

- `show` and `run` with a valid unknown name MUST exit 1 with
  `COMMAND_NOT_FOUND` and suggestions from the lookup registry.
- Empty and invalid names on `show` and `run` MUST exit 2 with
  `INVALID_COMMAND_NAME` before agent resolution and MUST never surface as
  `UNHANDLED_ERROR`.
- An unknown agent MUST exit 1 with `AGENT_NOT_FOUND` before command
  discovery, after command-name validation where applicable.
- Invalid `limit` and `offset` MUST exit 2 with `USAGE_ERROR`, never exit 1
  with `COMMAND_FAILED`.
- Valid `--fields` MUST project equal `items` and `commands` rows.
- One unknown field, alone or mixed with valid fields, MUST exit 2 with the
  stable `acceptedFields` set, including when no commands are discovered. It
  MUST never produce `{}` rows with exit 0.
- Every success payload MUST validate against its declared return schema.
- Parser-level invalid flags and arguments SHOULD exit 2 with accepted usage
  metadata.
- Bare `ravi commands` MUST print operation help and exit 0.

## Read-Only and Determinism Checks

- Repeating each operation against unchanged input MUST preserve JSON values
  and ordering.
- Repeating a paginated list MUST preserve `pagination.nextCommand`.
- Repeating a render MUST preserve `metadata.renderedPromptSha256`.
- `list`, `show`, `validate`, and `run` MUST leave command files, config,
  sessions, and runtime transport unchanged.
- `run` MUST remain a pure renderer and MUST NOT publish to a session.
- No COMMANDS operation may exit 3.
- `validate` MUST preserve its exit-1 file verdict when validation errors
  exist.

## Surface Checks

- The handler's stable list fields, return schema, generated tool surface,
  Ravi Spec, and shipped COMMANDS skill MUST remain coherent.
- The skill MUST document name validation, pagination, strict fields, exit
  taxonomy, and the absence of write effects.
- `bun test src/cli/commands/commands.test.ts` SHOULD pass after every change
  to this surface.
- SDK generation/check, typecheck, build, quality gate, and documentation lint
  SHOULD pass before the increment is considered ready.

# Tools Registry / CHECKS

## Search Returns Parseable JSON

```bash
ravi tools search "session attach" --json --limit 5
```

- Output MUST be valid JSON.
- `query` field MUST match the input.
- `limit` MUST be present.
- `total` MUST be present.
- `items` MUST be an array with ranked results.
- Each item MUST have `name`, `description`, `score`, `matchedFields`.

## Search Is Bounded

```bash
ravi tools search "list" --json
```

- `items` length MUST NOT exceed the default limit (10).

## Dry-Run Test Does Not Execute

```bash
ravi tools test tools_list '{}' --json
```

- `mode` MUST be `"dry_run"` or `executed` MUST be `false`.
- Output MUST NOT contain `result.content` with tool output.
- `invokeCommand` MUST be present.
- `schema` MUST be present.

## Invoke Executes Handler

```bash
ravi tools invoke tools_list '{}' --json
```

- `mode` MUST be `"executed"` or `executed` MUST be `true`.
- `result` MUST be present with `isError` and `content`.

## Invoke Preserves Authorization

```bash
ravi tools invoke tools_list '{}' --json
```

- The command access annotation MUST be `mutate/high`.
- The handler MUST use the same enforcement path as runtime tool execution.

## Search Never Calls Handler

A sentinel test in `src/cli/commands/tools.test.ts` MUST prove that
`tools search` does not call any `tool.handler` function.

# Tools Registry / CHECKS

## Search Returns Parseable JSON

```bash
ravi tools search "session attach" --json --limit 5
```

Expected:

- output is valid JSON;
- `query` field matches the input;
- `limit` is present;
- `total` is present;
- `items` is an array with ranked results;
- each item has `name`, `description`, `score`, `matchedFields`.

## Search Is Bounded

```bash
ravi tools search "list" --json
```

Expected:

- `items` length does not exceed the default limit (10).

## Dry-Run Test Does Not Execute

```bash
ravi tools test tools_list '{}' --json
```

Expected:

- `mode` is `"dry_run"` or `executed` is `false`;
- no `result.content` with tool output;
- `invokeCommand` is present;
- `schema` is present.

## Invoke Executes Handler

```bash
ravi tools invoke tools_list '{}' --json
```

Expected:

- `mode` is `"executed"` or `executed` is `true`;
- `result` is present with `isError` and `content`.

## Invoke Preserves Authorization

```bash
ravi tools invoke tools_list '{}' --json
```

Expected:

- the command access annotation is `mutate/high`;
- the same enforcement path as runtime tool execution is used.

## Search Never Calls Handler

A sentinel test in `src/cli/commands/tools.test.ts` MUST prove that
`tools search` does not call any `tool.handler` function.

# Runbook

## Add A New Tool

1. Define the tool id with dot notation, for example `prox.note.create`.
2. Write input and output JSON schemas.
3. Choose side-effect class.
4. Choose executor type.
5. Configure timeout, redaction, and output limits.
6. Bind the tool to one or more `call_profile`s.
7. Run `ravi prox calls tools run <tool_id> --input <json> --dry-run --json`.
8. Run a real call only after dry-run and policy pass.

## Bash Tool Checklist

- Use fixed `cwd`.
- Use fixed executable and argv template.
- Do not use freeform shell.
- Set timeout.
- Set stdout/stderr byte limits.
- Allowlist env.
- Redact sensitive fields.
- Return structured JSON if possible.

## Debug A Tool Failure

1. Inspect call timeline:

```bash
ravi prox calls events <call_request_id> --json
```

2. Inspect tool runs:

```bash
ravi prox calls tools runs <call_request_id> --json
```

3. Validate tool definition:

```bash
ravi prox calls tools show <tool_id> --json
```

4. Dry-run the same input:

```bash
ravi prox calls tools run <tool_id> --input ./input.json --profile <profile_id> --dry-run --json
```

## If Provider Tool Name Does Not Resolve

- Check `call_tool_binding.provider_tool_name`.
- Check whether the profile used by the call is the expected one.
- Check whether the provider is using dynamic config or a Studio-side pipeline.
- Studio-side tools must still call Ravi's bridge with a name mapped to a Ravi binding.

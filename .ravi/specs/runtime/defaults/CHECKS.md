# Runtime Defaults Checks

## Commands

```bash
ravi settings set runtime.defaultProvider claude
ravi settings set runtime.defaultModel opus
ravi settings set runtime.defaultEffort high
ravi settings get runtime.defaultModel --json
ravi settings delete runtime.defaultModel --execute
ravi sessions info <session> --json
ravi agents show <id> --json
```

## Focused Tests

```bash
bun test src/runtime/runtime-defaults.test.ts src/runtime/runtime-selection.test.ts
bun test src/runtime/task-runtime-context.test.ts src/runtime/session-resolver.test.ts
bun test src/tasks/runtime-options.test.ts
bun test src/cli/commands/settings.test.ts src/cli/commands/sessions.test.ts
```

## Resolution Checks

- Stored `runtime.defaultModel` wins over `RAVI_MODEL`.
- `RAVI_MODEL` is used only when no stored/session/agent/preset model exists.
- Stored `runtime.defaultProvider` wins over the hardcoded default.
- Session/agent/preset values win over stored globals and env.
- A missing or disabled preset does not swallow into env.
- `sessions info` reports the same provider/model/effort and sources as launch
  and does not invent a model from a provider-only override.

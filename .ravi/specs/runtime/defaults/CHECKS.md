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

- Stored `runtime.defaultModel` MUST win over `RAVI_MODEL`.
- Resolution MUST use `RAVI_MODEL` only when no stored/session/agent/preset
  model exists.
- Stored `runtime.defaultProvider` MUST win over the hardcoded default.
- Session/agent/preset values MUST win over stored globals and env.
- Last-used `session.runtimeProvider` MUST win over agent/global defaults when
  no launch, observation, or session `set-provider` override is present.
- A daemon-restart snapshot provider MUST win over agent/global defaults when
  last-used is missing and no explicit override is present.
- An implicit default mismatch MUST NOT clear a compatible stored provider
  session id.
- A missing or disabled preset MUST reject launch and MUST NOT swallow into
  env.
- `sessions info` MUST report the same provider/model/effort and sources as
  launch and MUST NOT invent a model from a provider-only override.

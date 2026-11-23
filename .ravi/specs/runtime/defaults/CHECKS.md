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
bun test src/cli/commands/sessions-attach-authorization.test.ts
```

## Resolution Checks

- Unauthorized session provider/model propagation MUST return `PERMISSION_DENIED` for both compatible and incompatible pairs, leaving agent defaults, the target session, and sibling sessions unchanged.
- An unauthorized provider switch without `--propagate` MUST return `PERMISSION_DENIED` before compatibility validation and leave configuration unchanged.
- `sessions set-provider <s> <p> --model <m>` MUST validate the pair together and write
  the provider and model overrides in one command; without `--model`, an incompatible
  current model MUST be refused with the `--model` and `set-model clear` paths named.
- `sessions set-model <s> clear` MUST be refused when the fallback model (agent default or
  runtime default) cannot run on the session's provider, and MUST NOT change anything then.
- `agents set <id> provider <p>` MUST refuse, naming the sessions, when a session without its
  own provider override pins a model override that `<p>` cannot run; with `--force` it MUST
  clear exactly those overrides and leave compatible ones.
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

# Runtime Prompt Rules / CHECKS

## Checks

Run the focused regression suite:

```bash
bun test src/runtime/runtime-system-prompt.test.ts src/runtime/codex-provider.test.ts src/runtime/session-trace.test.ts
```

Run adjacent task coverage:

```bash
bun test src/tasks/service.test.ts src/tasks/profiles.test.ts
```

Run import command coverage:

```bash
bun test src/cli/commands/rules.test.ts
```

Run repository gates:

```bash
bun run typecheck
bun run build
```

Sync specs after editing this directory:

```bash
bin/ravi specs sync --json
```

## Regression Scenarios

- Missing `.ravi/rules` emits no `Ravi Rules` section.
- Empty `.ravi/rules` emits no `Ravi Rules` section.
- Non-empty `.ravi/rules` emits one `Ravi Rules` section.
- Nested rule files are included in deterministic relative-path order.
- `.gitkeep` and other hidden files are ignored.
- Codex fallback injects `Ravi Rules` when runtime instructions do not include it.
- Codex fallback does not duplicate `Ravi Rules` when runtime instructions already include it.
- Runtime trace metadata includes `id=ravi.rules`.
- `ravi rules import` dry-run does not write files.
- `ravi rules import` excludes user-level sources unless `--include-user` is passed.
- `ravi rules import` skips existing imported files unless `--force` is passed.
- `ravi rules import` does not expose rule content in JSON summaries.

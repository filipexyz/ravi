# Runtime Defaults Runbook

## Change The Next-Turn Defaults

```bash
ravi settings set runtime.defaultProvider claude
ravi settings set runtime.defaultModel opus
ravi settings set runtime.defaultEffort high
```

These writes are immediate (no `--execute`). The next unshadowed turn uses the
new values. No daemon restart is required.

## Inspect What The Next Turn Will Use

```bash
ravi sessions info <session> --json
ravi agents show <id> --json
ravi settings get runtime.defaultModel
```

Read `effectiveProvider` / `providerSource`, `effectiveModel` / `modelSource`,
and `runtimeOptions.effort`. Provider sources are `launch_override`,
`observation_override`, `session_override`, `last_used`, `restart_snapshot`,
`agent_preset`, `agent_default`, `global_default`, or `runtime_default`.

## Clear A Stored Default

```bash
ravi settings delete runtime.defaultModel          # dry-run, exit 3
ravi settings delete runtime.defaultModel --execute
```

After delete, resolution falls back to `RAVI_MODEL` if set, otherwise the
hardcoded last resort (`sonnet` / `codex` / `xhigh`).

## Session And Agent Overrides

```bash
ravi sessions set-provider <session> claude
ravi sessions set-model <session> opus
ravi sessions set-effort <session> high
ravi agents set <id> provider claude
ravi agents set <id> model opus
ravi agents set <id> effort high
```

These remain the per-session and per-agent knobs. They win over the stored
globals. Use `clear` on the session commands to remove only the override.

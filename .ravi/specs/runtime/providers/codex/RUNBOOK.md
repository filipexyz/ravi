# Codex Provider Runbook

## Debug A Stuck Codex Turn

1. Inspect `adapter.request` for provider, model, cwd, prompt hash, and previous provider session id.
2. Inspect `provider.raw` events for `thread/started`, `turn/started`, and `turn/completed`.
3. If a tool started, verify there is a matching `tool.completed`.
4. If an app-server dynamic tool request appears, treat it as unexpected. Verify Ravi returned protocol-safe `success` plus `contentItems`, but did not execute a Ravi CLI registry command.
5. If a reaction or silent turn happened, verify `turn.complete` was emitted even without assistant text.
6. If the native child exited, verify the provider emitted `turn.failed` or `turn.interrupted`.
7. If there is no `turn/completed`, inspect the app-server response schema and adapter event normalization before touching host runtime.

## Runtime Control

```bash
ravi sessions runtime list <session> --json
ravi sessions runtime read <session> --json
ravi sessions runtime steer <session> "..." --json
ravi sessions runtime interrupt <session> --json
ravi sessions runtime rollback <session> 1 --json
ravi sessions runtime fork <session> --json
```

## CLI Context Debug

- Confirm `adapter.request` includes runtime env metadata and the request went through the Codex provider path.
- Confirm `runtime-request-context.ts` issued or resolved a live context for the session.
- Confirm `runtime-request-builder.ts` passed the env into `RuntimeStartRequest`.
- Confirm the Codex app-server process receives `RAVI_CONTEXT_KEY`.
- If the session reuses an existing app-server process, confirm the provider respawned it when the `RAVI_*` env signature changed.
- Confirm the Codex app-server was launched with `shell_environment_policy.inherit=all`, `shell_environment_policy.ignore_default_excludes=true`, and an `include_only` glob allowlist containing `RAVI_*`.
- Confirm `~/.codex/hooks.json` points the `^(Bash|shell)$` hook at `ravi context codex-bash-hook` or repo `bin/ravi context codex-bash-hook`, not a test file.
- Confirm the Bash hook returns `{}` for allowed Bash calls. It is a permission/skill-gate hook, not an env injector.
- Confirm the shell command env contains `RAVI_CONTEXT_KEY`; if it does not, debug `shell_environment_policy`, not the hook output.
- Confirm model-initiated Ravi actions use shell commands, for example `ravi tasks list`, not native Codex dynamic tools.
- If provider raw method `item/tool/call` appears, confirm it produces a failed semantic tool event and no `hostServices.executeDynamicTool` call.

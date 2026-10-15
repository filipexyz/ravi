# Claude Code Provider Runbook

## Debug A Turn

1. Check `adapter.request` for resume/fork, model, hooks, plugin names, spec server, remote spawn, and prompt hashes.
2. Check `provider.raw` events for stream deltas, assistant blocks, user tool results, and final result.
3. If a tool starts but never ends, inspect whether a native tool-result event was emitted.
4. If a turn fails after interruption, verify whether the host classified it as recoverable interruption.
5. If a model switch happened, verify whether `setModel` was called and whether subsequent turns used the new model.
6. If spec mode failed open, inspect host hook attachment and spec server activation.

## Common Checks

- Session id should persist on `turn.complete`.
- Fork should only happen when parent provider state belongs to the same provider.
- Hooks should not be attached when capabilities say unsupported.
- Remote spawn should not be attached unless the agent has remote config.
- Spec server should not be attached unless the agent is in spec mode.

## SSH Authentication And CLI Recovery

1. If a token works in a direct local Claude invocation but the SSH agent gets
   401, validate the launcher with `bun test src/remote-spawn.test.ts` before
   requesting a replacement token. Literal newline escapes in the export script
   can corrupt an otherwise valid credential.
2. Check that the SSH process receives `RAVI_CONTEXT_KEY` and
   `RAVI_GATEWAY_URL`, without printing either credential. Loopback agents can
   use the daemon HTTP listener; other hosts need an explicit reachable URL.
3. Run `ravi --version` as the SSH user and align that CLI with the daemon.
   Install its production dependencies too. A stale PATH wrapper can select an
   older checkout even when the current package is already installed.
4. Validate `ravi self whoami --json`, `ravi self explain --json` and
   `ravi self permissions --json` from that user with the issued context. Do not
   grant access to the operator's state directory to repair gateway routing.
5. Only after validating the registered credential through the corrected
   launcher, clear its stale health failure with
   `ravi runtime credentials reset-health <credential-id> --json`.

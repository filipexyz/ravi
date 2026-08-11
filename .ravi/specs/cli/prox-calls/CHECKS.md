# Prox Calls agent-first CLI contract / CHECKS

## Checks

- `prox calls request` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with profile/provider ids, person/phone/reason presence,
  dynamic-variable count and `providerMode`. It MUST NOT expose the person id,
  phone, reason or variable keys/values, persist a `call_requests` row or touch
  a provider.
- `prox calls request` with `--execute` MUST submit the call request through
  `submitCallRequest` (stub provider in tests).
- `prox calls request` with an unknown `--profile` MUST exit 1 with
  `CALL_PROFILE_NOT_FOUND` and local suggestions, BEFORE the brake fires.
- `prox calls cancel` MUST cancel a pending request WITHOUT `--execute` — the
  damage-stop rationale is declared in code and skill.
- `profiles configure` with a real ElevenLabs synchronization MUST exit 3
  without `--execute`, before local persistence or HTTP. With `--execute` it
  MUST persist and synchronize; `--skip-provider-sync` MUST persist locally
  without confirmation or HTTP.
- `prox calls show|events|transcript` on an unknown request MUST exit 1 with
  `CALL_REQUEST_NOT_FOUND`; a request without transcript MUST exit 1 with
  `TRANSCRIPT_NOT_FOUND` (retryable).
- `voice-agents show` and `tools show` on unknown ids MUST exit 1 with
  `VOICE_AGENT_NOT_FOUND` / `CALL_TOOL_NOT_FOUND` and suggestions from the
  local DB.
- `profiles list --fields a,b --json` MUST narrow `items` and keep the
  `profiles` alias identical to `items`; same rule for voice-agents/tools.
- `voice-agents sync` MUST remain dry-run by default and `tools run --dry-run`
  MUST remain side-effect free — these pre-existing flags are the brake
  equivalents and MUST NOT be renamed.
- `bun test src/cli/commands/prox-calls.test.ts` SHOULD pass after any change
  to the prox-calls contract surface.

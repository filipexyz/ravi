# Runbook

1. Build with `bun run build`. Keep the feature disabled on existing installations
   until the matching Console bridge v2 client and trust configuration are ready.
2. Provision an isolated runtime, explicit model credential and private state.
   Enable `RAVI_HUMAN_BRIDGE=1` only there. A custom Responses provider uses a
   private JSON file selected by `RAVI_BRIDGE_CODEX_PROVIDER_FILE`; its fields are
   `id`, `baseUrl` (HTTPS) and `apiKeyFile` (absolute private file).
3. Use `ravi bridge --help` and `ravi bridge enroll --help` for enrollment. Exchange
   runtime/issuer pins through a trusted management path. Never accept browser
   supplied pins or export a runtime context/model secret to the Console.
4. Configure a dedicated SSH account with only `ravi bridge serve-stdio`, without
   PTY, forwarding, arbitrary commands or access to runtime/model data. Authorize
   humans and tools in the Console policy, not in local agent profiles.
5. Verify two synthetic users independently: private conversation, idempotent
   send, response/history/replay, exact-action owner approval, cancellation,
   grant/deny and live revocation. Require the native model/runtime for E2E proof.
6. Disable the listener and stop outstanding test work to roll back. Preserve
   bridge receipts/journal; do not replay uncertain turns. Existing non-bridge
   state requires no schema migration or conversion.

The bridge v2 protocol intentionally rejects v1; it requires a matching client.
The CLI now loads `.env` from the selected `RAVI_STATE_DIR`; default installations
still use `~/.ravi/.env`. An explicitly separate state directory must contain its
own configuration rather than inheriting another installation's secrets.

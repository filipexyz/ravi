# Channels Credentials / CHECKS

## Authorization Before Backend Read

- Broker MUST check `use:credential:slack:<connection_id>` before resolving any secret ref.
- Broker MUST check action capability (`execute:slack:socket_mode.connect`, `execute:slack:messages.send`, `execute:slack:files.read`, or `execute:slack:reactions.write`) before resolving secret material.
- A caller with `use:credential:slack:<connection_id>` but without the required action capability MUST be denied.
- A caller without `use:credential:slack:<connection_id>` MUST be denied regardless of action capabilities.

## Dry-Run Without Backend Read

- A broker dry-run or preflight check MUST validate connection status and authorization without reading secret material from the backend.
- Dry-run MUST return connection metadata, status, and authorization result but MUST NOT return secret refs, backend coordinates, or resolved values.

## Disabled / Expired / Revoked Fail-Closed

- A connection with status `suspended` MUST fail closed before any backend read.
- A connection with status `expired` MUST fail closed before any backend read.
- A connection with status `revoked` MUST fail closed before any backend read.
- A missing connection id MUST fail closed with a clear error.
- A connection with mismatched workspace/app identity MUST fail closed.

## Composite Secret Atomicity

- Broker MUST resolve both `app_token_ref` and `bot_token_ref` atomically for Socket Mode connect.
- If one secret part is missing or unresolvable, the entire resolution MUST fail. The runner MUST NOT proceed with a partial credential set.
- Broker MUST resolve only `bot_token_ref` for Web API actions that do not require the app token.

## Redaction In Error / Log / Audit

- Raw token values (`xapp-...`, `xoxb-...`) MUST NOT appear in daemon logs.
- Raw token values MUST NOT appear in `ravi events stream` output.
- Raw token values MUST NOT appear in CLI JSON output from `ravi credentials`.
- Raw token values MUST NOT appear in error messages from broker resolution failures.
- Raw token values MUST NOT appear in Slack request body logs or traces.
- Authorization headers containing Slack tokens MUST be redacted in any logged HTTP request/response.
- Backend secret coordinates (Keychain item names, Vault paths) MUST NOT appear in public output.
- Redacted aliases MUST appear in place of secret values wherever a human-readable reference is needed.

## Slack Runner Without Token In Prompt / Event

- The Slack runner MUST NOT inject raw token values into agent prompts.
- The Slack runner MUST NOT include raw token values in NATS events, session events, or turn traces.
- The Slack runner MUST NOT store raw token values in `ChannelInstance` config or `ravi.db`.
- The Slack runner MUST NOT forward raw token values to runtime provider processes.

## Channel Instance Binding

- `ChannelInstance` MUST reference `credential_connection_id`, not raw token values.
- `ravi instances list --json` MUST show `credential_connection_id` and redacted alias, not raw tokens.
- Changing the credential connection on an instance MUST be an explicit operator action.

## Env Var Fallback (Dev Mode Only)

- When the broker is available and a connection is registered, the runner MUST prefer broker-resolved secrets.
- When falling back to env vars, the runner MUST emit a deprecation warning.
- Env var fallback MUST NOT be used when a registered connection exists and is active.

## Validation Commands

```bash
ravi specs sync --json
ravi specs get channels/credentials --mode full --json
ravi specs get channels/credentials --mode checks --json
ravi specs get channels --mode full --json
ravi specs get credentials/broker --mode full --json
ravi specs get credentials/controls --mode checks --json
bun run typecheck
bun run build
```

---
id: cli/media
title: "Media agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - media
tags:
  - cli
  - media
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/media.ts
  - src/cli/media-send.ts
  - src/cli/media-send-omni.ts
  - src/cli/media-send-auth.ts
  - src/cli/media-send-access.ts
  - src/cli/remote-gateway.ts
  - src/omni-config.ts
  - src/cli/commands/sessions.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
<!-- markdownlint-disable-next-line MD025 -->
# Media agent-first CLI contract

## Intent

Make `ravi media` reliable for agent consumers under the agent-first contract
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy and a
write brake on `media send` — the op that delivers a file to a REAL chat on a
live channel (WhatsApp, Slack, or Telegram/Discord through the legacy bridge)
and cannot be unsent.

## Invariants

1. With `--json`, every failure on `media send` MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   delivery) · `2` usage error · `3` blocked by policy (write brake).
3. `media send` MUST default to dry-run and require `--execute`; the dry-run
   MUST report `dryRun: true` and a semantically minimal `plan` with
   `fileName`, `mimeType`, `mediaType`, `captionPresent`, `voiceNote` and a
   target containing only `channel`, `accountId`, `chatIdPresent` and
   `threadIdPresent`. The plan MUST NOT contain the resolved path, caption,
   chat ID or thread ID, and MUST NOT call any transport (the WhatsApp runner,
   the Slack native sender or the legacy-bridge `omni` CLI).
4. A missing local file MUST exit 1 with `FILE_NOT_FOUND` BEFORE the brake — no
   plan is shown for a send that could never happen.
5. Delivery failures after `--execute` MUST exit 1. A `ChannelTransportError`
   (WhatsApp RPC errors such as `WHATSAPP_RUNNER_UNAVAILABLE`,
   `WHATSAPP_NOT_BOUND`, `NOT_CONNECTED` or `WHATSAPP_RPC_TIMEOUT`, and the
   routing errors `INSTANCE_NOT_FOUND` / `CHANNEL_PROVIDER_UNSUPPORTED`) MUST
   keep its own code and `retryable`, with a sanitized message and a
   `suggestedAction` (`mapChannelMediaFailure`). Any other failure maps to
   `MEDIA_SEND_FAILED` (`retryable: true`), except a legacy-bridge `401` /
   `Invalid API key`, which MUST exit 1
   with `OMNI_AUTH_FAILED` (`retryable: false`) and a `suggestedAction` that
   names the `servers.list.<active>.apiKey` vs top-level `apiKey` /
   `OMNI_API_KEY` divergence without echoing the key or raw provider payload.
   Isolated remote projection MUST keep those catalog codes and replace the
   remote message / `suggestedAction` with the local catalog copy. Generic
   codes such as `COMMAND_FAILED` stay `Remote command failed.` The projection
   MUST NOT echo remote text, keys, URLs, or provider payloads. `FILE_NOT_FOUND`
   on `media send` uses the same local catalog copy; the same code on another
   `op` MUST NOT receive media copy.
6. `media send --execute` MUST route by instance like the outbound router
   (`classifyInstanceRoute`): Slack → native Slack upload; a WhatsApp instance
   (bound or not) → `messages.sendMedia` on the `ravi channels` runner with the
   absolute `filePath`, never Omni and with no Omni fallback; a
   `twilio-whatsapp` / `gupshup` record → 422 `CHANNEL_PROVIDER_UNSUPPORTED`;
   an unmapped instance → 404 `INSTANCE_NOT_FOUND`; any other instance → the
   legacy bridge (`sendMediaWithOmniCli` in `src/cli/media-send-omni.ts`,
   loaded on demand).
7. On the legacy-bridge branch, `media send --execute` MUST authenticate the
   spawned Omni CLI with the same
   `apiUrl`/`apiKey` `resolveOmniConnection()` gives the Ravi Omni
   client/runtime. Because the Omni CLI prefers `servers.list.<active>.apiKey`
   over the flat / env key, the child process MUST receive an isolated
   `OMNI_CONFIG_DIR` whose `servers.list.default` mirrors that resolved
   connection (plus `OMNI_API_URL` / `OMNI_API_KEY`).
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| send | external delivery to a live chat (high) | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| local file missing | `FILE_NOT_FOUND` | 1 |
| WhatsApp runner or routing failure | the transport code (`WHATSAPP_RUNNER_UNAVAILABLE`, `WHATSAPP_NOT_BOUND`, `INSTANCE_NOT_FOUND`, `CHANNEL_PROVIDER_UNSUPPORTED`, ...) with its own `retryable` | 1 |
| other delivery failure | `MEDIA_SEND_FAILED` (retryable) | 1 |
| legacy-bridge 401 / invalid API key | `OMNI_AUTH_FAILED` (not retryable) + config-divergence suggestedAction | 1 |
| braked send without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- `src/cli/commands/sessions.ts` (`buildCurrentSessionMediaSendCommand` and the
  `sendMedia` usage hint) teaches `ravi media send "<file-path>" --execute` to
  live agents; the builder MUST carry `--execute`. `sessions actions` MUST
  advertise `media.send` as available only when the current runtime snapshot
  allows `media send` (or when no snapshot is present, in which case channel
  capability remains). Explicit `--account` / `--to` do not grant authority.
- `ravi image generate` and `ravi audio generate` return a `sendCommand` field
  that MUST carry `--execute` (`ravi media send "<path>" --execute`).

## Known gaps

- SKILL GAP: there is no `media` skill under
  `src/plugins/internal/ravi-system/skills/`; the surface is taught only through
  the sessions action hints and the image/audio skills. A dedicated skill (or a
  section in a channel skill) is pending.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `media` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/media-json.test.ts` green (the `media send
  contract` block included, including the WhatsApp runner error and
  `OMNI_AUTH_FAILED`).
- `bun test src/cli/media-send.test.ts src/cli/media-send-auth.test.ts src/cli/media-send-access.test.ts src/cli/remote-gateway.test.ts src/omni-config.test.ts`
  green (credential wiring + 401 classification + isolated catalog projection).
- Live checks: `ravi media send /tmp/img.png --json` → exit 3 + plan; adding
  `--execute` delivers; `ravi media send /tmp/nope.png --json` →
  `FILE_NOT_FOUND`, exit 1.

## Known Failure Modes

- `sendChannelMedia` both validates the file and resolves the target, then
  calls a transport; the brake must run BEFORE it, so the command
  re-implements the cheap local checks (existsSync + mime inference) and shows
  the context-resolved target in the plan without calling any transport.
- A WhatsApp media failure MUST NOT fall back to the legacy bridge: the runner
  error is the answer (start it with `ravi channels start`).
- Consumers that teach `ravi media send` without `--execute` put live agents in
  an exit-3 loop; the sessions builders and the image/audio `sendCommand`
  strings are the canonical teaching surfaces and carry the flag.

---
id: voice/cli
title: Voice CLI
kind: capability
domain: voice
capability: cli
tags:
  - voice
  - cli
  - sdk
  - gateway
applies_to:
  - src/cli/commands/voice.ts
  - src/sdk
  - packages/ravi-os-sdk
owners:
  - ravi-dev
status: draft
normative: true
---

# Voice CLI

## Intent

`ravi voice` is the stable CLI and SDK surface for live speech conversations with Ravi agents.

Provider and media details MUST be options or transport ids under this domain. They MUST NOT become top-level operator concepts such as `ravi realtime`.

## Command Groups

```bash
ravi voice profiles ...
ravi voice transports ...
ravi voice sessions ...
```

## Profiles

```bash
ravi voice profiles list [--transport <id>] [--enabled] [--limit <n>] [--offset <n>] [--json]
ravi voice profiles show <profile-id> [--json]
ravi voice profiles create <profile-id> --transport <id> [--model <model>] [--voice <voice>] [--reasoning-effort <provider-supported-value>] [--json]
ravi voice profiles update <profile-id> [--model <model>] [--voice <voice>] [--reasoning-effort <provider-supported-value>] [--enabled <bool>] [--json]
ravi voice profiles delete <profile-id> [--json]
```

Profile commands MUST NOT accept or print provider secrets.

For `openai-direct`, profile creation SHOULD default to `gpt-realtime-2` when the operator omits `--model`.

`profiles delete` MUST be soft-delete/disable when any voice session references the profile. Hard delete is allowed only for unreferenced profiles.

List output MUST use the standard CLI pagination contract.

## Transports

```bash
ravi voice transports list [--json]
ravi voice transports check <transport-id> [--json]
```

`check` MUST report redacted readiness and next operator action.

It MUST NOT perform a billable live model call unless an explicit future `--live` flag exists.

## Sessions

```bash
ravi voice sessions start \
  --session <session-name-or-key> \
  --profile <profile-id> \
  [--agent <agent-id>] \
  [--chat <chat-id>] \
  [--client <wa-overlay|cli|sdk|test>] \
  [--transport <transport-id>] \
  [--idempotency-key <key>] \
  [--json]

ravi voice sessions connect <voice-session-id> \
  [--sdp-offer-file <path|->] \
  [--json]

ravi voice sessions list \
  [--session <session-name-or-key>] \
  [--agent <agent-id>] \
  [--state <state>] \
  [--limit <n>] \
  [--offset <n>] \
  [--json]

ravi voice sessions status <voice-session-id> [--json]
ravi voice sessions events <voice-session-id> [--limit <n>] [--offset <n>] [--follow] [--json|--jsonl]
ravi voice sessions transcript <voice-session-id> [--json]
ravi voice sessions interrupt <voice-session-id> [--json]
ravi voice sessions end <voice-session-id> [--json]
```

## JSON Contract

`start --json` MUST return:

```ts
{
  voiceSession: {
    id: string;
    state: string;
    profileId: string;
    transportId: string;
    model?: string;
    voice?: string;
    reasoningEffort?: string;
    sessionKey: string;
    sessionName?: string;
    agentId: string;
    chatId?: string;
    expiresAt?: string;
  };
  connection: {
    mode: "webrtc-sdp" | "webrtc-token" | "livekit-room";
    expiresAt?: string;
    requiresClientSdp?: boolean;
    targetUrl?: string;
    nextCommand?: string;
    clientSecret?: string;
    roomUrl?: string;
    roomToken?: string;
  };
  hints: {
    status: string;
    end: string;
    interrupt: string;
    events: string;
  };
}
```

If `connection.clientSecret` or `connection.roomToken` is present, it MUST be short-lived, scoped to the voice session, and safe for the browser client. Long-lived provider API keys MUST NOT appear.

For `webrtc-sdp`, `start --json` SHOULD NOT return provider credentials. It SHOULD return `requiresClientSdp: true` and a `nextCommand`/SDK hint telling the client to create an SDP offer and call `sessions.connect`.

`connect --json` MUST return:

```ts
{
  voiceSession: {
    id: string;
    state: string;
    providerCallId?: string;
    connectedAt?: string;
    expiresAt?: string;
  };
  connection: {
    mode: "webrtc-sdp" | "webrtc-token" | "livekit-room";
    sdpAnswer?: string;
    expiresAt?: string;
  };
  hints: {
    status: string;
    end: string;
    interrupt: string;
    events: string;
  };
}
```

For `webrtc-sdp`, `connect --json` MUST include `connection.sdpAnswer` and MUST NOT include provider API keys or raw provider session config.

`status --json` MUST return state, timestamps, transport, profile, Ravi session identity, redacted provider ids, and recent terminal/error information.

`events --json` MUST return a paginated event page. `events --follow` SHOULD use `--jsonl` and MUST be marked CLI-only unless exposed through a proper streaming SDK transport.

## Human Output

Human output SHOULD be compact and include next useful commands:

- after `start`: connect/status/end;
- after `connect`: events/interrupt/end;
- after failure: transport check command and relevant redacted fix hint.

## SDK/Gateway Exposure

Commands intended for the extension MUST be SDK-safe:

- `profiles.list`;
- `profiles.show`;
- `transports.list`;
- `transports.check`;
- `sessions.start`;
- `sessions.connect`;
- `sessions.status`;
- `sessions.transcript`;
- `sessions.interrupt`;
- `sessions.end`.

SDK-safe means the command MAY be exposed through the gateway only when the active context key has permission for the target Ravi session/chat/profile. SDK-safe `sessions.start` and `sessions.connect` MAY return browser connection material, but only for the caller's own voice session and only with short expiry.

SDK/gateway implementations MUST redact `connection.clientSecret`, `connection.roomToken`, and `connection.sdpAnswer` from logs, traces, persisted command history, and error telemetry.

Long-lived streaming commands such as `events --follow` MUST NOT be exposed as fake single-shot SDK commands. Use a future streaming SDK capability or polling-friendly event pagination.

## Permissions

Starting a voice session requires read access to the Ravi session and permission to create a voice session for that agent/profile.

Connecting a voice session requires ownership or modify access to that voice session and MUST validate that the voice session was created for the same authenticated client context or an explicitly permitted backend operator.

Interrupting or ending a voice session requires modify access to the voice session or its parent Ravi session.

Tool execution uses voice profile tool policy plus Ravi runtime permission policy.

## Acceptance Criteria

- `ravi voice` is discoverable from root help.
- All machine commands support `--json`.
- List/history commands paginate.
- SDK generated clients can call the extension-safe commands.
- No command leaks provider secrets.

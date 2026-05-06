---
id: prox/calls/voice-agents
title: "prox.city Calls Voice Agents"
kind: feature
domain: prox
capability: calls
feature: voice-agents
capabilities:
  - voice-agent-contract
  - provider-agent-mapping
  - prompt-versioning
  - toolset-binding
  - runtime-config
tags:
  - prox-city
  - calls
  - voice-agents
  - contracts
  - elevenlabs
  - agora
applies_to:
  - src/prox
  - src/cli/commands/prox-calls.ts
  - src/webhooks
owners:
  - ravi-dev
status: draft
normative: true
---

# prox.city Calls Voice Agents

## Intent

`call_voice_agent` is Ravi's canonical definition of a voice-facing agent that can speak during a prox call.

It exists because provider dashboards are not a reliable source of product behavior. Ravi must know which voice agent was used, what prompt/version it had, which tools it could call, and how it maps to provider runtime config.

## Concept Split

These concepts MUST stay separate:

- `Ravi agent`: operational session/runtime identity that can request calls, create tasks, and operate Ravi.
- `call_voice_agent`: voice persona/runtime that talks to a human during a call.
- `call_profile`: use-case wrapper such as `followup`, `checkin`, `interview`, or `urgent-approval`.
- `call_tool`: typed function a voice agent may call through Ravi.
- `call_rules`: policy deciding whether/when a call can happen.

A Ravi agent MAY request a call using a `call_profile`. The profile resolves a `call_voice_agent`. The voice agent talks during the call and may call tools allowed by the effective tool policy.

## Entity Contract

`call_voice_agent` MUST include:

- stable `id`;
- `name`;
- `description`;
- `provider`;
- optional `provider_agent_id`;
- optional `voice_id`;
- `language`;
- `system_prompt` or `system_prompt_path`;
- `first_message_template`;
- `dynamic_variables_schema_json`;
- `provider_config_json`;
- `version`;
- `enabled`;
- timestamps.

`provider_agent_id` semantics are provider-specific but MUST be explicit:

- for ElevenLabs, it maps to the ElevenLabs agent id;
- for Agora Studio, it maps to the pipeline id;
- for Agora full-config, it MAY be empty because Ravi generates runtime config dynamically.

## Profile Relationship

`call_profile` SHOULD reference `voice_agent_id`.

The profile owns use-case framing:

- reason/purpose template;
- default dynamic variables;
- extraction schema;
- voicemail policy;
- result routing defaults;
- rules scope;
- provider overrides that are use-case-specific.

The voice agent owns persona/runtime behavior:

- who is speaking;
- speaking style;
- base system prompt;
- first-message template;
- default voice/language;
- default provider runtime config;
- default toolset.

Changing a profile MUST NOT silently mutate a voice agent. Changing a voice agent MUST be versioned because existing call history needs a stable explanation of what talked to the person.

## Versioning

Every material change to a voice agent SHOULD bump `version`.

Material changes include:

- system prompt text/path;
- first-message template;
- voice id;
- provider runtime config;
- default tool bindings;
- dynamic variables schema.

`call_request` or `call_run` SHOULD persist a snapshot reference:

- `voice_agent_id`;
- `voice_agent_version`;
- `voice_agent_snapshot_json` when needed for audit.

This prevents old calls from becoming impossible to explain after provider/dashboard changes.

## Tool Relationship

Voice agents participate in the tooling contract.

A voice agent MUST NOT call arbitrary tools. Tools must be declared through `prox/calls/tooling`.

Effective tool exposure SHOULD be computed from:

1. `call_voice_agent` default tool bindings;
2. `call_profile` tool bindings/overrides;
3. `call_tool_policy`;
4. request/run context.

If there is conflict between voice-agent defaults and profile policy, the stricter rule wins.

For MVP, it is acceptable to bind tools at profile scope only, but the storage/API MUST leave room for voice-agent-scoped tool bindings. The target contract is:

```text
voice_agent knows how to use tool X
profile allows tool X for this use case
policy allows this specific run to execute tool X
```

## Provider Mapping

Provider adapters MUST map `call_voice_agent` to provider config.

### ElevenLabs

ElevenLabs MAY keep a provider-side agent.

Ravi MUST store:

- provider agent id;
- prompt/source path used by Ravi;
- first message template;
- dynamic variables schema;
- extraction expectations;
- tool bridge bindings when supported.

Provider sync MAY push Ravi voice-agent changes to ElevenLabs, but the local Ravi definition remains canonical.

### Agora

Agora full-config SHOULD be generated from Ravi `call_voice_agent` + `call_profile` + effective tools.

Agora Studio pipeline MAY be used, but if it is used:

- the pipeline id MUST be stored as `provider_agent_id`;
- the Ravi voice-agent record MUST still describe the intended behavior;
- Studio tools MUST call Ravi's bridge and map to Ravi tool bindings.

## CLI Contract

The CLI surface SHOULD be:

```bash
ravi prox calls voice-agents list [--json]
ravi prox calls voice-agents show <voice_agent_id> [--json]
ravi prox calls voice-agents create <voice_agent_id> --name <name> --provider <provider> [--system-prompt-path <path>] [--voice-id <id>] [--json]
ravi prox calls voice-agents configure <voice_agent_id> [--system-prompt-path <path>] [--first-message <text>] [--voice-id <id>] [--provider-agent-id <id>] [--json]
ravi prox calls voice-agents bind-tool <voice_agent_id> <tool_id> [--provider-tool-name <name>] [--json]
ravi prox calls voice-agents unbind-tool <voice_agent_id> <tool_id> [--json]
ravi prox calls voice-agents sync <voice_agent_id> [--provider] [--dry-run] [--json]
```

`sync --dry-run` MUST show what would change in the provider without mutating remote state.

## Initial Voice Agents

Initial examples SHOULD be:

- `ravi-followup`: short, direct follow-up calls.
- `ravi-interviewer`: longer interview/assessment calls.
- `ravi-urgent-approval`: explicit yes/no approval or blocker calls.
- `ravi-intake`: prox.city intake calls.

These are product-level voice agents. They MUST NOT be confused with runtime agents such as `dev`, `main`, or `videomaker`.

## Acceptance Criteria

- A call can show which `call_voice_agent` and version talked to the person.
- A profile can reference a voice agent without duplicating all provider configuration.
- Provider-side agent ids are mapped explicitly, not inferred from dashboard state.
- Voice agent prompts/toolsets are versioned or snapshotted for audit.
- Effective tools respect voice-agent defaults, profile bindings, and policy.
- Provider adapters can generate or validate provider config from Ravi's local voice-agent definition.
- No voice agent can execute tools outside the `prox/calls/tooling` contract.

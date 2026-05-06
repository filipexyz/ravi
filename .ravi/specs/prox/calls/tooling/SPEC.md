---
id: prox/calls/tooling
title: "prox.city Calls Tooling Contract"
kind: feature
domain: prox
capability: calls
feature: tooling
capabilities:
  - voice-agent-tools
  - voice-agent-toolsets
  - bash-backed-tools
  - provider-tool-bridge
  - tool-policy
  - tool-audit
tags:
  - prox-city
  - calls
  - tools
  - contracts
  - bash
  - sdk
applies_to:
  - src/prox
  - src/cli/commands/prox-calls.ts
  - src/webhooks
owners:
  - ravi-dev
status: draft
normative: true
---

# prox.city Calls Tooling Contract

## Intent

`prox calls tooling` is the contract for every function exposed to a voice agent during a prox call.

The system MUST be flexible enough to let calls use Ravi SDK capabilities and internal CLIs, but it MUST NOT give providers or voice agents arbitrary shell access.

The core rule:

```text
voice agents call typed tools; Ravi owns validation, policy, execution, audit, and result normalization.
```

## Boundary

- Ravi owns tool definitions, bindings, policy, execution, audit trail, and normalized tool results.
- Providers MAY expose tool schemas to their voice agents, but those schemas MUST be generated from or matched to Ravi `call_tool` definitions.
- Provider adapters MUST NOT execute business tools directly.
- Provider adapters MUST call Ravi's tool bridge.
- Every provider tool call MUST resolve to a known `call_tool_binding`.
- Every provider tool call MUST resolve through the effective `call_voice_agent` and `call_profile`.
- Every tool execution MUST be attached to a `call_request` and SHOULD be attached to a `call_run`.
- Every tool execution MUST persist a `call_tool_run` and append a `call_event`.

## Entities

The parent `prox/calls` spec defines:

- `call_voice_agent`;
- `call_tool`;
- `call_tool_binding`;
- `call_tool_policy`;
- `call_tool_run`.

New storage MUST implement those concepts directly or through equivalent tables with the same semantics. Implementations MUST NOT hide call tools inside provider-specific JSON blobs as the only source of truth.

## Tool Definition Contract

Every `call_tool` MUST include:

- stable id using dot notation, for example `call.end`;
- human-readable name;
- voice-agent-oriented description;
- JSON input schema;
- JSON output schema;
- executor type;
- executor config;
- side-effect class;
- timeout;
- enabled flag;
- created/updated timestamps.

Allowed executor types:

- `native`: implemented inside Ravi.
- `bash`: executes a predefined CLI command through Ravi's controlled runner.
- `http`: reserved for internal service calls.
- `context`: reserved for Ravi context-issued child processes.

Allowed side-effect classes:

- `read_only`;
- `write_internal`;
- `external_message`;
- `external_call`;
- `external_irreversible`.

Tool output SHOULD normalize to:

```json
{
  "ok": true,
  "message": "Safe text for the voice agent",
  "data": {},
  "next_instruction": "Optional instruction for what the agent should do next"
}
```

`message` MUST be safe to return to the voice provider. Sensitive data belongs in `data` only when policy allows it.

## Binding Contract

Tools are exposed to voice agents through `call_tool_binding`, not by global availability.

Bindings MUST support voice-agent scope and profile scope.

Bindings MUST define:

- Ravi `tool_id`;
- scope type, at least `voice_agent` or `profile`;
- scope id;
- provider-facing tool name;
- enabled flag;
- optional tool-specific prompt;
- whether the tool is required by the profile.

Voice-agent scoped bindings define what a voice persona knows how to use.

Profile scoped bindings define which tools are allowed for a specific use case.

Effective exposure SHOULD be:

```text
voice_agent binding + profile binding/policy + request context = tools exposed to provider
```

A tool safe for an internal interview voice agent MAY be unsafe for a public outbound profile. Voice-agent and profile scopes must both be represented in the contract, even if the first MVP stores only one of them and documents the limitation.

## Policy Contract

Policy MUST be evaluated before executor invocation.

Policy MUST be able to block by:

- tool id;
- voice agent id;
- profile id;
- request/run context;
- side-effect class;
- person/contact/project scope;
- missing confirmation;
- missing `RAVI_CONTEXT_KEY` authorization;
- max calls per run;
- disabled tool/profile.

`external_message` and `external_irreversible` MUST require explicit policy allowance before MVP exposure.

Provider prompts MUST NOT be treated as security boundaries.

## Bash Executor Contract

Bash-backed tools exist to connect voice agents to any internal CLI quickly.

They MUST be controlled tools, not freeform shell.

A Bash executor config MUST define:

- fixed `cwd`;
- command executable;
- argv template;
- environment allowlist;
- timeout;
- stdout format;
- stdout/stderr byte limits;
- redaction rules.

Bash executors MUST:

- validate input against schema before rendering args;
- pass arguments as argv whenever possible;
- reject command separators, implicit `eval`, shell interpolation, and unbounded output;
- use `RAVI_CONTEXT_KEY` when the child CLI needs Ravi identity or authorization;
- capture stdout/stderr into `call_tool_run`;
- redact configured fields before persistence or provider response;
- return structured failure on non-zero exit;
- never crash the call runtime directly.

Bash executors MUST NOT:

- accept arbitrary command text from the voice agent;
- inherit all environment variables;
- print secrets into logs, events, transcripts, provider output, or tool results;
- run without timeout.

## Tool Bridge Contract

The canonical provider-neutral bridge SHOULD be:

```text
POST /webhooks/prox/calls/tools?request_id=<call_request_id>
```

Provider-specific aliases MAY exist, but they MUST route into the same executor:

```text
POST /webhooks/agora/tools?request_id=<call_request_id>
```

The bridge MUST:

- authenticate the caller;
- resolve `call_request`;
- resolve the latest eligible `call_run` when available;
- map provider tool name to `call_tool_binding`;
- validate input schema;
- evaluate policy;
- persist `call_tool_run`;
- execute with timeout;
- append `call_event`;
- return provider-shaped output from the normalized tool result.

## Provider Mapping

Agora full-config SHOULD receive dynamically generated tool schemas from Ravi when the call profile has bindings.

Agora Studio pipelines MAY define tools manually, but each tool MUST call Ravi's bridge and MUST map to a Ravi `call_tool_binding`.

ElevenLabs tools MAY live in the provider agent, but each tool MUST call Ravi's bridge. Provider-side synchronization SHOULD be added when the adapter supports it.

Provider adapters MUST keep provider-specific transport details outside business tool definitions.

Provider adapters MUST compute tools from the resolved `call_voice_agent` plus `call_profile`, not from provider dashboard state alone.

## CLI Contract

The CLI MUST be agent-first, JSON-stable, and usable for dry-run validation.

Minimum planned surface:

```bash
ravi prox calls tools list [--profile <profile_id>] [--json]
ravi prox calls tools show <tool_id> [--json]
ravi prox calls tools create <tool_id> --name <name> --description <text> --executor <native|bash|http|context> --side-effect <kind> [--input-schema <path>] [--output-schema <path>] [--json]
ravi prox calls tools configure <tool_id> [--timeout-ms <ms>] [--enabled <true|false>] [--json]
ravi prox calls tools bind <profile_id> <tool_id> [--provider-tool-name <name>] [--required] [--tool-prompt <text>] [--json]
ravi prox calls tools unbind <profile_id> <tool_id> [--json]
ravi prox calls voice-agents bind-tool <voice_agent_id> <tool_id> [--provider-tool-name <name>] [--json]
ravi prox calls voice-agents unbind-tool <voice_agent_id> <tool_id> [--json]
ravi prox calls tools runs <call_request_id> [--json]
ravi prox calls tools run <tool_id> --input <json-or-path> [--profile <profile_id>] [--dry-run] [--json]
```

`tools run --dry-run` MUST validate schema, binding, policy, and command rendering without causing side effects.

CLI errors MUST explain:

- what failed;
- why it failed;
- what command or config fixes it.

## Initial Canonical Tool Families

The first tool families SHOULD be:

- `call.*`: call control, starting with `call.end`.
- `person.*`: safe person/contact/context lookup.
- `prox.note.*`: internal notes and insights from calls.
- `prox.followup.*`: scheduled follow-up or future call requests.
- `task.*`: task creation or handoff after a call.

The first concrete tools SHOULD be:

- `call.end`;
- `person.lookup`;
- `prox.note.create`;
- `prox.followup.schedule`;
- `task.create`.

## Validation Use Cases

The contract MUST support these use cases without provider-specific business logic:

- end a call after the objective is complete;
- look up safe context about the person being called;
- save an internal note from the conversation;
- schedule a future follow-up;
- create a task for another Ravi agent/runtime;
- prepare an outbound message only when policy allows it;
- block payment, contract approval, or irreversible external action by default.

## Non-Goals

- arbitrary shell access for voice agents;
- generic public tool marketplace;
- exposing all Ravi CLI commands to providers;
- using provider prompt instructions as the security model;
- implementing provider-specific business tools that bypass Ravi storage.

## Acceptance Criteria

- A new prox call tool cannot be exposed without a `call_tool` definition.
- A voice agent cannot expose a tool unless it has a `call_tool_binding`.
- A profile cannot use a tool unless effective binding/policy allows it.
- Every provider tool call creates or updates a durable `call_tool_run`.
- `ravi prox calls events <request>` shows tool started/completed/failed/blocked events.
- Bash-backed tools run with fixed command, fixed cwd, timeout, env allowlist, and output limits.
- Invalid input fails before execution.
- Blocked policy returns a structured blocked result to the provider.
- Secrets are redacted from logs, tool output, events, and transcripts.
- Provider adapters call the tool bridge instead of executing business logic directly.

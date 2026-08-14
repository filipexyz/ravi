# Why a Native Kimi Code Provider

## Problem reference

The normative provider contract and release requirements are in
[`SPEC.md`](SPEC.md). The implementation rationale, threat model, and rejected
alternatives are in the
[Kimi Code Provider Hardening Design](../../../../../docs/superpowers/specs/2026-08-11-kimi-code-provider-hardening-design.md).
Lifecycle ownership, durable cleanup, and crash-retry decisions are recorded in
the [Kimi Code Provider Lifecycle Ownership Design](../../../../../docs/superpowers/specs/2026-08-11-kimi-code-provider-lifecycle-ownership-design.md).

## Decision

Implement a direct Kimi Code membership API adapter before attempting a Kimi Code
CLI/runtime adapter.

## Why this fits RAVI

RAVI's provider contract defines providers as translators. The host remains
responsible for sessions, queueing, permissions, tools, traces, tasks, responses,
and continuity. A direct Chat Completions adapter has a narrow responsibility:

```text
RuntimeStartRequest
  -> Kimi request and tool loop
  -> canonical RuntimeEvent stream
```

This boundary is smaller and more testable than embedding a second agent runtime.

## System boundary

```text
RAVI dispatcher/request builder
  -> KimiCodeProvider
     -> credential resolution
     -> request + bounded SSE transport
     -> event normalizer + atomic terminal tracker
     -> serialized host-service tool loop
     -> versioned provider transcript
  -> RAVI host event loop, persistence, traces, tasks, and channels
```

The adapter owns protocol translation. It does not own credential rotation, generic
retry/cooldown policy, permission policy, external side-effect reconciliation,
channel delivery, or task state.

## Why not replace Pi

Pi is a general multi-provider runtime and remains useful. Removing it would be an
unrelated breaking change. Some users may prefer Pi's file-backed sessions or
provider catalog. The new adapter exists for users who want explicit Kimi identity,
direct subscription API use, and RAVI host tools without the extra runtime layer.

## Why not configure Claude as Kimi

Kimi documents Anthropic compatibility, but the RAVI Claude adapter describes
Claude Code capabilities and SDK semantics. Reusing its identity would make
capability detection, error attribution, model options, tracing, and support
ambiguous. Protocol compatibility does not make two runtimes semantically equal.

## Why OpenAI-compatible first

The OpenAI-compatible Kimi surface directly represents streamed `tool_calls`, tool
results, usage, and Kimi reasoning fields. It is a better fit for an explicit,
provider-local normalizer than hiding Kimi behind Claude SDK behavior.

The transport must still be isolated behind an interface. If wire verification
shows the Anthropic-compatible subscription endpoint has materially stronger or
more stable semantics, changing the provider-local transport should not affect the
RAVI host contract.

## Why media is deferred

Kimi's media capability is model input. RAVI's current prompt contract is text-only.
Adding media correctly requires canonical content blocks, storage/attachment
lineage, channel transport, size limits, redaction, and provider mappings. Claiming
support in only this adapter would create a false capability and bypass the host
boundary.

## Why tools are serialized

The active RAVI runtime spec records a single-active-tool limitation. Serializing
tool calls preserves identifiers, lifecycle events, and permission checks. Parallel
execution can be enabled only after the host state model is changed generically.

## Why preserved reasoning is internal

Kimi may require prior assistant reasoning fields during a tool loop or later turn.
That protocol state must be preserved for correctness, but it is not the public
assistant answer. Keeping it inside versioned provider state avoids both semantic
loss and accidental chain-of-thought exposure.

## Cost of the decision

- RAVI owns an HTTP/SSE adapter and its compatibility maintenance.
- Stateless API continuity requires a validated host transcript.
- The first version does not provide Kimi Code CLI tools, MCP, plugins, or swarm.
- Account quota and model availability require real-world smoke tests after offline
  correctness is established.

## Future decision

A separate ADR should decide whether to add `kimi-code-runtime` if Kimi publishes a
stable machine-readable CLI protocol. That decision must not mutate this provider's
identity or silently change API-backed sessions into CLI-backed sessions.

## Maintenance policy

The provider needs an explicit maintainer and a recurring compatibility check of:

- the upstream RAVI provider/capability/session-state contract;
- Kimi Code endpoint, headers, model IDs, context and effort semantics;
- streaming, tool, usage, quota and error wire shapes;
- private smoke and redaction fixtures.

An incompatible change must disable the affected model/capability or block release.
It must not trigger a silent protocol fallback, client-identity spoof, or invented
pricing/quota behavior.

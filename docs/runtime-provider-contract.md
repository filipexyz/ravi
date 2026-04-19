# Runtime Provider Contract

This document is the contract for running multiple execution providers behind one Ravi runtime.

The provider is an adapter. The Ravi runtime owns sessions, routing, tasks, permissions, delivery barriers,
events, audit, and user-facing responses.

## End-to-End Flow

```text
channel message
  -> omni consumer
  -> ravi.<session>.prompt
  -> RuntimePromptSubscription
  -> RuntimeSessionDispatcher
  -> RuntimeSessionLauncher
  -> RuntimeProvider.startSession(RuntimeStartRequest)
  -> RuntimeEvent stream
  -> RuntimeEventLoop
  -> ravi.session.<session>.runtime/tool/stream/response
  -> gateway / overlay / tasks / audit
```

## Runtime Ownership

Ravi owns:

- session identity and source metadata
- agent config and runtime provider selection
- task/profile/runtime override resolution
- delivery barriers and prompt queueing
- permission policy, audit, user approval, and command gating
- canonical runtime events and user-facing failure messages
- provider session state persistence

Providers own:

- translating `RuntimeStartRequest` into the provider transport
- normalizing native transport output into `RuntimeEvent`
- declaring capability support through `RuntimeCapabilities`
- exposing optional controls such as interrupt, model switch, or thread controls

Providers must not:

- mutate tasks directly
- bypass Ravi permission policy
- emit channel responses directly
- rely on `bot.ts` provider-specific branches
- invent event shapes outside `RuntimeEvent`

## Provider Capability Matrix

Provider behavior must be selected from `RuntimeCapabilities`, not hard-coded provider IDs outside
provider adapters and registry code.

Important capability gates:

- `supportsSessionResume`: stored runtime session state can be reused.
- `supportsSessionFork`: thread sessions can fork from parent provider state.
- `supportsPartialText`: `text.delta` can be streamed as partial output.
- `supportsToolHooks`: restricted tool access can be enforced by runtime/provider hooks.
- `supportsHostSessionHooks`: host-native session hooks are available.
- `supportsPlugins`: Ravi plugins can be passed into the provider.
- `supportsMcpServers`: spec servers can be attached to the runtime session.
- `supportsRemoteSpawn`: remote execution can be attached to the runtime session.
- `toolAccessRequirement`: chooses whether access requires full tool+executable rights or only tool surface rights.
- `legacyEventTopicSuffix`: compatibility-only event suffix. New consumers should read canonical runtime events.

## Start Request

`RuntimeStartRequest` is the only start contract:

- `prompt`: async generator of `RuntimePromptMessage`
- `model`, `effort`, `thinking`
- `cwd`
- `resume`, `resumeSession`, `forkSession`
- `abortController`
- `systemPromptAppend`
- `env`
- `settingSources`
- `permissionOptions`
- `canUseTool`
- `approveRuntimeRequest`
- `dynamicTools`
- `handleRuntimeToolCall`
- `mcpServers`
- `hooks`
- `plugins`
- `remoteSpawn`

Unsupported fields are omitted before calling the provider based on capabilities.

## Request Assembly Boundary

The host assembles `RuntimeStartRequest` through small provider-agnostic modules:

- `runtime-request-context.ts`: Ravi context, tool context, and Ravi-owned env.
- `runtime-provider-bootstrap.ts`: provider `prepareSession`, host services, and plugin exposure.
- `runtime-session-continuity.ts`: resume/fork decision from stored provider state.
- `runtime-host-attachments.ts`: optional hooks, spec server, and remote spawn attachments.
- `runtime-request-builder.ts`: final composition only; it should not absorb provider-specific policy.

When adding another LLM agent provider, prefer adding adapter code inside that provider and selecting behavior
through `RuntimeCapabilities`. Do not add provider branches to `bot.ts`, `session-launcher.ts`, or
`runtime-request-builder.ts`.

## Events

Providers must normalize all transport output into `RuntimeEvent`.

Canonical events:

- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `text.delta`
- `status`
- `assistant.message`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `turn.interrupted`
- `turn.failed`
- `turn.complete`

The event loop persists provider state only from canonical events. Legacy event topics are compatibility
surfaces and must not become the source of truth.

## Model Switching

Model switching is strategy-based:

- `direct-set`: the active runtime handle exposes `setModel`.
- `restart-next-turn`: the provider cannot switch the active session directly, so Ravi shuts down the
  current runtime and restarts on the next turn.

The dispatcher chooses the strategy from the runtime handle. It must not branch on provider ID.

## Permissions

There is one Ravi permission policy with provider-specific adapters:

- host hooks call the policy before native tool execution.
- host services call the policy for dynamic tools, command execution, user input, and capability checks.

The provider can choose the adapter path through capabilities, but it cannot implement a separate permission model.

## `bot.ts` Boundary

`bot.ts` is the composition root:

- construct subscriptions
- construct dispatcher
- start/stop runtime host services
- expose narrow compatibility wrappers for tests and CLI glue

It should not own:

- provider bootstrap
- provider event handling
- task runtime resolution
- permission checks
- prompt queue policy
- provider-specific model switching

## Compliance Requirements

Every built-in provider must pass contract tests for:

- capability matrix stability
- compatibility preflight
- prepare-session output shape
- model switch strategy
- runtime event normalization in provider-specific tests
- provider state persistence through the event loop

New providers should start with:

1. `RuntimeProvider` implementation with explicit `RuntimeCapabilities`.
2. `prepareSession` only if the provider needs env, dynamic tools, approvals, or local bootstrap.
3. Event normalizer tests from native output into canonical `RuntimeEvent`.
4. Contract test entry proving capability shape and prepare-session output shape.
5. Runtime guard test only when a new capability path is introduced.

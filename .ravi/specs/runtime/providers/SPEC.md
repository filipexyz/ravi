---
id: runtime/providers
title: "Runtime Providers"
kind: capability
domain: runtime
capabilities:
  - providers
tags:
  - runtime
  - provider-contract
  - adapters
applies_to:
  - src/runtime/types.ts
  - src/runtime/provider-registry.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/runtime-provider-bootstrap.ts
  - src/runtime/host-event-loop.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Providers

## Intent

Runtime providers are adapters from a native execution engine into Ravi's canonical runtime. They allow Ravi to use multiple engines while preserving one host lifecycle, one permission model, one trace model, and one response pipeline.

## Provider Contract

A provider MUST implement:

- `id`: stable runtime provider id.
- `getCapabilities()`: explicit matrix of supported host features.
- `startSession(RuntimeStartRequest)`: returns a live `RuntimeSessionHandle`.

A provider MAY implement:

- `prepareSession(...)`: bootstrap env, dynamic tools, or approval handlers before `RuntimeStartRequest` is built.
- `interrupt()`: terminate or interrupt an active turn.
- `setModel(model)`: live model switch.
- `control(request)`: provider-native runtime controls such as thread read, fork, rollback, steer, or interrupt.

The host dispatcher MAY route a concurrent human prompt through `control({ operation: "turn.steer" })` only when the live handle explicitly opts into native concurrent input steering and the delivery barrier is `after_tool`. If control fails, is unsupported, or the handle did not opt in, the host MUST fall back to the normal Ravi queue/interruption path without losing the prompt.

Host-side debounce and provider-native steering are different layers:

- Debounce is a pre-runtime UX batching decision controlled by agent/channel config.
- Runtime `pendingMessages` is the host delivery queue used after a session handle exists.
- Provider-native `turn.steer` is a control operation for injecting an additional prompt into an existing native run.

Adapters with native steering MAY bypass Ravi `pendingMessages` for interactive `after_tool` messages after a live handle exists, but MUST opt in through the runtime handle and MUST NOT disable debounce unless the agent/channel config says so. Handles that only expose generic runtime control default to Ravi queue + interrupt semantics.

## Runtime goals

Providers may advertise `goal.get`, `goal.set` and `goal.clear` through runtime control capabilities. They return provider-neutral `RuntimeGoal` snapshots, normalize timestamps to Unix milliseconds, and emit `goal.updated` for native state changes. The runtime owns lifecycle, continuation and usage; the Ravi host mirrors confirmed snapshots and maintains local links.

An optional `controlSession` method performs metadata-only control of a persisted unloaded session, using opaque provider session params for storage identity. It MUST NOT start inference. The host uses live handles during work, and retires idle handles before activating through stored control plus managed prompt delivery. Unsupported providers MUST fail explicitly. See `sessions/goals` for the complete contract.

## Model Selectors

Agent `model` values are provider-specific strings, but Ravi MUST still reject selectors that are structurally invalid before saving config. Validation belongs in the runtime model catalog/provider-local code, not scattered across unrelated CLIs.

Minimum validation:

- Reject empty model values.
- Reject whitespace in model values.
- Reject malformed `provider/model` selectors with an empty provider or model segment.
- For Pi, reject known provider ids used alone as model selectors, such as `kimi-coding`; use `kimi-coding/kimi-for-coding` instead.

Deep validation against a live provider catalog or credentials MAY be implemented as explicit preflight, but MUST NOT be required for every config write unless the provider can do it cheaply and deterministically.

## Model Option Compatibility

Provider adapters MUST treat model options as model-specific capabilities, not as global provider defaults.

When a provider introduces a model with a changed option contract, Ravi MUST update the provider SDK or adapter before exposing that model as supported. The adapter MUST then normalize Ravi's canonical runtime options into only the native options accepted by that model.

At minimum, model capability data SHOULD cover:

- whether `thinking` can be disabled;
- whether adaptive thinking is required;
- supported adaptive thinking displays;
- supported reasoning effort values;
- output configuration support;
- sampling parameter support;
- tool-use, vision, PDF, response schema, prompt caching, and computer-use support when the provider reports those features.

Adaptive-thinking-only models MUST NOT receive a native disabled-thinking option. If Ravi's canonical request asks for `thinking=off`, the adapter MUST omit the native thinking override or map it to the provider's documented no-op/default behavior instead of sending an invalid disabled-thinking payload.

Pricing and capability metadata SHOULD come from a maintained model catalog when available. Hardcoded model branches MAY be used as a short-term compatibility shim, but each branch MUST be covered by provider tests and SHOULD be replaced by model catalog data.

A model that has no catalog pricing entry MUST be reported as unpriced with a zero cost, not assigned invented or family-fallback pricing.

## Reasoning Effort

Reasoning effort is a canonical runtime option drawn from `none|minimal|low|medium|high|xhigh|max|ultra`. It is separate from the model selector and MUST NOT be embedded in a model id.

- Unsupported or unknown effort MUST fail clearly or be rejected before provider handoff; silent fallback MUST NOT mask invalid input on new CLI/task paths.
- The Codex adapter MUST propagate `max` and `ultra` as `model_reasoning_effort` for both the exec transport and the app-server `thread/start` and `thread/resume` calls, without renaming the selected model.
- A provider MAY map canonical effort to its strongest compatible native value (for example `xhigh -> max`) only when that mapping is covered by explicit provider tests.

## Credential Fallback

Provider credential selection and fallback are governed by `runtime/providers/credential-fallback`.

Provider adapters MUST expose enough structured, redacted failure data for the host to distinguish rate limits, quota exhaustion, billing failures, invalid credentials, permission failures, provider overload, network transients, context limits, invalid requests, and unknown failures.

Provider adapters MUST NOT implement hidden credential rotation in provider-local code. Selection, cooldowns, health transitions, retry limits, replay safety, and operator-visible events belong in the generic runtime credential fallback layer.

Provider adapters MAY own provider-specific secret/env/profile mapping, but MUST NOT leak raw credential values into logs, traces, provider raw summaries, shell tool env, or session params.

Provider session ids and resume/fork state used with managed credentials MUST be credential-compatible. A provider adapter MUST NOT resume or fork native state across different account/profile credential boundaries unless it explicitly declares that the native provider session is account-independent.

## Agent Runtime Env

Every command an agent runs inherits the env of its provider process (Claude Code, Codex, Pi, Grok), and the agent can also read that process env directly (`ps -E`, `/proc/<pid>/environ`). The provider process env is therefore the agent's env, and the boundary is drawn where the process is spawned.

- The env of a provider process MUST be built from an allowlist (`src/runtime/agent-env-policy.ts`, applied in `buildRuntimeEnv`). The daemon env MUST NOT be inherited wholesale.
- A daemon env name reaches the provider only if it is on the exact-name list, or matches an allowed toolchain prefix (`LC_`, `XDG_`, `GIT_`, `NODE_`, and similar) and does not look like a secret (`TOKEN`, `SECRET`, `PASSWORD`, `_KEY`, `_PAT`, `DSN`, `HEADERS`, database URLs, and similar).
- `RAVI_*` and `OMNI_*` names are never passed by prefix. Each one is on the exact-name list (state dir, gateway endpoint, CLI bundle, logging, jobs, daemon restart, execution plane), so a new Ravi variable does not reach agents until it is listed on purpose. Daemon-only config and internal markers (`RAVI_GATEWAY_INTERNAL`, `RAVI_IDENTITYD_*`) stay out.
- A value is dropped even under an allowed name when it contains a URL with userinfo (`user:pass@`, `:pass@` or `token@`) or is shaped like a credential: `sk-…`, `ghp_…`/`github_pat_…`, `xox…-`, a JWT (`eyJ….…`), a PEM block (`-----BEGIN …`) or an AWS access key id (`AKIA…`). The token-shape check does not apply to directory lists (any name ending in `PATH`: `PATH`, `GOPATH`, `MANPATH`, `*_PATH`): a directory named like a token is not a credential, and dropping the list would drop the whole search path. The URL check bounds the scheme to 32 characters so a long value costs linear time.
- Provider configuration prefixes are scoped: `CLAUDE_*` and `ANTHROPIC_*` reach only Claude, `CODEX_*` only Codex, `PI_*` only Pi, `GROK_*` only Grok. The scope also holds for names in the passthrough, so `ANTHROPIC_CUSTOM_HEADERS` reaches Claude only when passed through and never reaches another provider.
- Git's env config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`) is passed or dropped as a whole, never partially, because git refuses to run with an incomplete trio and the values can carry credentials. It is dropped by default and passed only when the passthrough names one of its members. `GIT_CONFIG_PARAMETERS` is dropped unless passed through.
- After the filter, the request adds on purpose: the Ravi turn env (`RAVI_CONTEXT_KEY`, session and actor ids), the selected managed credential (`providerEnv`), and the provider's own login variables when it inherits them from the daemon env (Claude: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; Codex: `OPENAI_API_KEY`, `CODEX_API_KEY`; Grok: `XAI_API_KEY`; Pi: none). A provider MUST NOT receive another provider's login variables.
- Extra names reach agents only when the operator lists them in `RAVI_AGENT_ENV_PASSTHROUGH` (comma or space separated) in the daemon env. Nothing else opts a secret in.
- Every spawn of a provider process MUST go through the same filter, including stored-session control spawns (Codex `controlSession`) and the runtime liveness probe (`runtime-probe.ts`, which still resolves credentials from the whole env). Spreading `process.env` into a provider spawn is a defect.
- A `ravi jobs run` job runs in the daemon and MUST start with the same filtered env (`buildJobEnv` in `src/jobs/runner.ts`), whoever created it; its output returns to whoever asked, so inheriting the daemon env would hand the secrets back. There is no operator exception: the installed `ravi` runs in the terminal with no gateway in between, and the default credential belongs to an agent, so the daemon cannot verify that a job is the operator's. A job that needs a secret gets it from `RAVI_AGENT_ENV_PASSTHROUGH`, for unprefixed names only: provider-prefixed names (`CLAUDE_*`, `ANTHROPIC_*`, `CODEX_*`, `PI_*`, `GROK_*`) belong to the agent runtime and MUST NOT reach a job, even when listed, because the job filter runs with no provider. The credential broker has no tested path for jobs yet.
- A shell trigger (`triggers add --shell/--exec`) MUST run only when its owner acts as the operator, like a shell cron (`TRIGGER_SHELL_NOT_OPERATOR`). It MUST be created or changed only from a request the daemon verified (gateway or tool transport), by a requester that acts as the operator and, for an existing trigger, is its owner: `add`, any `set` on a shell trigger or that turns one into a shell trigger, `enable` and `disable`. An edit by anyone else would clear the owner and turn the trigger off. Its env file MUST NOT resolve inside the Ravi state dir (`TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR`): symlinks are followed the way the OS opens the file, a path with a `..` segment counts as inside, and a child whose name starts with `..` is inside. It MUST be a regular file (`TRIGGER_SHELL_ENV_FILE_NOT_REGULAR`): the type is read with one `stat` call (`throwIfNoEntry: false`, and a path below something that is not a directory counts as missing), which never opens the file, before any `realpath` (Bun's `realpathSync` opens the path on macOS, and opening a FIFO would block the daemon's thread), and only directories are resolved while walking up a missing path. It MUST NOT have more than one hard link (`TRIGGER_SHELL_ENV_FILE_HARD_LINK`), since a hard link to a file in the state dir has a path of its own. It MUST NOT be larger than 1 MiB (`TRIGGER_SHELL_ENV_FILE_TOO_LARGE`), the most the loader reads, so an env file that grows past the limit takes the same turn-off-and-notify path at fire time instead of failing in the loader on every event. It MUST belong to the user Ravi runs as (`TRIGGER_SHELL_ENV_FILE_NOT_OWNED`) and MUST NOT be writable by its group or by others (`TRIGGER_SHELL_ENV_FILE_WRITABLE_BY_OTHERS`): an env file is code (`BASH_ENV`, `PATH`, `NODE_OPTIONS`), so whoever can write it decides what the command runs as the daemon's user. Known limit: on macOS an ACL entry (`chmod +a "user:<name> allow write"`) grants write without touching the mode bits, so the mode check does not see it (`ls -le` shows ACLs, `chmod -N` removes them); on Linux a POSIX ACL that grants write shows in the group bits (the ACL mask) and is refused. A path the check cannot verify MUST be refused as `TRIGGER_SHELL_ENV_FILE_UNVERIFIABLE`, never thrown as a raw error: a symlink loop (`ELOOP`), a directory Ravi may not search or a file it may not read (`EACCES`, `EPERM`; readability is checked with `access`, which does not open the file), or a path too long (`ENAMETOOLONG`). At fire time it turns the trigger off once with one notice, by direct message with no model in the path (`src/cron/automation-notice.ts`, the delivery a shell cron's notice and a cron failure use): for an env-file refusal, to its owner, who acts as the operator, or to the operator when nobody owns it or the owner has no direct chat; for `TRIGGER_SHELL_NOT_OPERATOR`, to the operator alone, because only the operator can recreate a shell and the owner (it can be a contact) would be messaged over the instance where Ravi last saw them, about something they cannot act on. Whenever that message does not reach the person it is for (no chat resolves, for example no contact or more than one is tagged as the operator, or the delivery fails) the notice MUST fall back to the default agent's main session, which is the operator's, so whoever can act on it is never left without it. The text MUST NOT carry the owner's id. It names the code and the reason, never the command, its env or the file's content. Any other file-system error (a transient `EMFILE`, for example) is thrown, logged by the runner, and leaves the trigger on. The env-file loader shared by shell crons and shell triggers opens the file once without blocking, checks on that descriptor that it is a regular file that belongs to the user Ravi runs as and that its group and others cannot write, and reads at most 1 MiB from it; a shell cron whose env file fails one of these checks fails its run with the reason. The owner and mode checks look at the descriptor the loader reads, so they hold for the content read. Without a uid (Windows) they do not apply. The location checks are path checks at create and at fire time, not an access boundary: the file can change between the check and the read, and the daemon and the command run as the same OS user. A fire refused for its env file logs the trigger id, turns the trigger off once and sends one notice by direct message to its owner, who acts as the operator, with the same fallback to the default agent's main session when no direct message goes out, like a refusal for its owner. On fire, the runner reads the stored row: a definition the cached copy does not share skips the fire, and the owner check, the command, the env file and the timeout all come from the stored row. A non-operator owner turns the trigger off once with one notice and never runs the command. The command starts from the allowlisted agent env plus its env file.
- Some allowlisted names are capabilities rather than configuration, and passing them is a decision: `SSH_AUTH_SOCK` lets the agent sign with the operator's SSH keys (push, ssh) without reading them, and `PM2_HOME` lets the agent control PM2, including stopping or restarting the daemon. Removing either breaks the matching workflow (git over SSH, `ravi daemon restart` from a turn).
- Secret stripping MUST NOT rely on rewriting the Bash command in a PreToolUse hook. Hooks that return `updatedInput` do not compose: each receives the original input, and the last rewrite wins (the job wrapper rewrites every command). A shell-level `unset` also leaves the provider process env readable.
- `SANITIZED_ENV_VARS` stays as an extra layer on top of the allowlist where a runtime must not hold even its own provider key (model broker mode, the Pi RPC process). It is not the agent boundary.
- Known limit: the provider's own login (for example `CLAUDE_CODE_OAUTH_TOKEN` inherited by Claude, or the selected managed credential) stays in the provider process env, so the agent can read it with `ps -E`. Only that one credential is exposed this way, never another provider's or a third party's.
- Known limit: the daemon itself holds the secrets, and the agent runs as the same OS user. Same-user reads of the daemon process env or of `~/.ravi/.env` are out of reach of this rule and need OS-level isolation (separate user or sandbox) plus the credential broker.

## Canonical Events

Providers MUST normalize native output into:

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

Providers MAY emit `provider.raw` for observability, but raw events MUST NOT be consumed as source of truth by product logic.

## Provider Stderr Logging

Provider adapters MAY buffer native stderr for crash diagnostics, but daemon logs MUST stay operationally useful.

Native provider stderr forwarding MUST distinguish signal from known benign provider noise:

- real `ERROR` lines and unknown `WARN` lines SHOULD remain visible as daemon warnings;
- known benign Codex skill loader warnings about `interface.icon_*` paths MAY be suppressed to debug while preserving the full stderr buffer;
- known benign Codex MCP process-group cleanup warnings during restart, shutdown, or already-exited subprocess cleanup MAY be suppressed to debug while preserving the full stderr buffer.

Suppressing a provider stderr line MUST NOT remove it from the per-transport stderr buffer used for crash and turn diagnostics.

## Capability Matrix

Legacy compatibility fields still exposed:

- `supportsSessionResume`
- `supportsSessionFork`
- `supportsPartialText`
- `supportsToolHooks`
- `supportsHostSessionHooks`
- `supportsPlugins`
- `supportsMcpServers`
- `supportsRemoteSpawn`
- `toolAccessRequirement`
- `legacyEventTopicSuffix`

Structured capabilities every provider MUST expose:

- `runtimeControl`: whether provider control is supported and which operations are accepted.
- `dynamicTools`: whether the provider can call Ravi-provided dynamic tools.
- `execution`: whether the provider runs through SDK, subprocess RPC, subprocess CLI, embedded code, or external service.
- `sessionState`: whether provider state is absent, session-id, thread-id, file-backed, or external-store.
- `usage`: whether token usage arrives on terminal events, streams incrementally, or is unavailable.
- `tools`: Ravi permission mode, required unrestricted access level, and parallel tool support.
- `systemPrompt`: append, override, or provider-composed prompt behavior.
- `terminalEvents`: whether terminal events are provider-guaranteed or adapter-enforced.
- `skillVisibility`: how the provider exposes skill availability, synchronization, advertisement, request, and loaded-state evidence.
- `modelOptions`: model-level option constraints such as disabled thinking, adaptive thinking, effort, output config, sampling, media, and tool-use support.

The legacy fields remain until downstream call sites are migrated. New provider decisions MUST prefer structured fields.

## Canonical Fork Support

Provider-native fork controls are not automatically Ravi session fork support. A provider advertises canonical fork only when it can materialize a Ravi fork plan from `runtime/session-continuity/forks`.

A provider that supports canonical fork MUST declare:

- supported Ravi fork point kinds, especially prompt atom boundaries.
- whether native fork copies state without mutating the parent.
- whether child rollback is available.
- whether replay is structured user/assistant history or a lossy plain text transcript.
- how the new provider state is persisted for a branch or current-session rebase.

Native controls such as Codex `thread.fork` or Pi `fork`/`clone` MAY remain available through `runtimeControl` for debugging and provider operations. They MUST NOT flip `supportsSessionFork` until the canonical materializer maps provider state to Ravi prompt atoms, traces, and session persistence.

## Pre-Pi Requirements

Before implementing the Pi adapter, Ravi SHOULD harden these generic runtime surfaces:

- Keep `RuntimeCapabilities` structured fields explicit for every provider. This first cut is implemented.
- Make the launcher reject incompatible agents from capability data instead of provider name checks. This is implemented for restricted tool access through `tools.permissionMode`.
- Make terminal-event recovery generic: subprocess exit, stream end, or accepted prompt without terminal result MUST become `turn.failed` or `turn.interrupted`. This is implemented by `RuntimeTerminalEventTracker`.
- Decide how the host event loop represents parallel tool execution, because Pi can execute tools concurrently while Ravi currently tracks one active tool in session state.
- Define generic file-backed provider session state, including cwd validation, session file paths, and display ids. This is implemented by `validateRuntimeSessionState`.
- Keep restricted tool access disabled for providers that do not route tool decisions through Ravi host services. This is enforced by compatibility checks.
- Add provider contract fixtures that run without live model calls. This is implemented for Pi through an injectable fake RPC transport.

## Integration Plan

1. Runtime contract foundation: structured capabilities, explicit provider matrices, and compatibility checks based on capabilities.
2. Terminality foundation: one generic helper that converts stream exit, subprocess exit, abort, or missing terminal result into exactly one terminal Ravi event.
3. Session-state foundation: generic validation for file-backed provider sessions, including cwd matching and safe display ids.
4. Tool-event foundation: keep Pi advertised as non-parallel until the host model supports parallel tool state; adapter must serialize/squash observable tool events if needed.
5. Pi RPC MVP: subprocess JSONL transport, fake transport tests, event normalization, interrupt, model/thinking controls, and resume state. The first adapter cut is implemented.
6. Dev rollout: explicit `provider=pi` on one dev agent only, text prompt E2E, tool prompt E2E, interrupt/resume/model-switch E2E.

## Invariants

- Provider adapters MUST NOT emit channel messages directly.
- Provider adapters MUST NOT mutate Ravi tasks or sessions directly, except through canonical terminal state returned to the host event loop.
- Provider adapters MUST NOT bypass Ravi permission policy.
- Provider adapters MUST NOT require provider-specific branches outside registry, model catalog, or provider-local files.
- Provider adapters MUST NOT send native model options that are incompatible with the selected model.
- Provider adapters MUST include enough metadata for trace correlation: provider, native event, thread id when available, turn id when available, item id when available.
- A provider that supports restricted tool access MUST route permission decisions through Ravi host services or host hooks.
- A provider that cannot support restricted access MUST declare that through capabilities so the launcher can reject incompatible agents.
- A provider that supports resume MUST return a `RuntimeSessionState` on `turn.complete`.
- A provider that supports fork MUST define how parent provider state maps into the child or rebased session, including prompt atom mapping.
- A provider that supports control MUST reject unsafe control operations while an active turn is running.
- `turn.steer` means “inject this into the active native run”; `turn.follow_up` means “run this after the active native run would otherwise stop”. CLIs and UIs MUST expose both semantics distinctly.
- A provider MUST NOT report a skill as loaded unless it can expose observed evidence or Ravi completed an explicit provider injection flow.
- A provider that cannot expose skill-loading evidence MUST declare that through `skillVisibility` and return conservative `session-visibility` state.
- A provider process MUST be spawned with the allowlisted agent runtime env (see Agent Runtime Env), never with the daemon env as-is.

## Validation

- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/*provider.test.ts`
- `bun test src/runtime/runtime-session-continuity.test.ts`
- `bun test src/runtime/model-switch.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- `bunx tsc --noEmit --pretty false`

## Known Failure Modes

- Provider ID checks spread into host runtime modules.
- A provider emits native success but no canonical `turn.complete`.
- Provider state is saved from a raw event before the turn actually completes.
- Tool approval succeeds in provider-native code while Ravi policy would deny it.
- Provider-native session ids are treated as user-visible session names.
- A provider with no hook support is started for an agent that needs restricted tools.
- A provider with no control support receives `sessions runtime` commands and fails silently.
- Model switching is implemented by provider name instead of handle strategy.
- Provider capability data says skills are supported, but session visibility can only prove local sync or prompt advertisement.
- Daemon secrets reach the agent shell because a provider spawn inherits `process.env` (found 18/11/2026: 27 secret names visible in a Claude turn, including `RAVI_ADMIN_TOKEN`; the PreToolUse `unset` hook never took effect because the job wrapper rewrote the command after it).

## Model Presets

A runtime model preset selects a provider and model selector that agents
reference indirectly. The preset provider is immutable and MUST match the
provider used to validate its model selector. When an agent references a preset,
the canonical resolver returns the preset provider as `effectiveProvider`, and
the runtime uses the provider's existing direct-set or restart-next-turn
strategy on the next turn. See `runtime/model-presets`.

# Runtime Providers Checks

## Contract Tests

- Provider exposes stable id.
- Capability matrix includes every required capability key.
- `prepareSession` output contains only allowed bootstrap fields.
- `startSession` returns a handle with `provider`, `events`, and `interrupt`.
- Optional `setModel` causes direct model switch strategy.
- Missing `setModel` causes restart-next-turn strategy.
- Model-specific option normalization omits unsupported native options.
- Adaptive-thinking-only models do not receive disabled-thinking payloads when Ravi canonical input is `thinking=off`.

## Reasoning Effort Tests

- Canonical effort MUST accept `max` and `ultra` and reject unknown values with a clear error before provider handoff.
- Codex exec transport MUST pass `max`/`ultra` through as `model_reasoning_effort` and MUST NOT rename the model.
- Codex app-server `thread/start` and `thread/resume` MUST carry `config.model_reasoning_effort` for `max`/`ultra`.
- Any `xhigh -> max` strongest-compatible mapping MUST be covered by an explicit provider test.
- A model with no catalog pricing entry MUST be reported as unpriced with zero cost.

## Event Normalization Tests

- Native assistant text maps to `assistant.message`.
- Native stream delta maps to `text.delta`.
- Native tool start maps to `tool.started`.
- Native tool result maps to `tool.completed`.
- Native success maps to `turn.complete`.
- Native failure maps to `turn.failed`.
- Native abort/interruption maps to `turn.interrupted`.
- Native usage maps to `RuntimeUsage`.
- Native session/thread id maps to `RuntimeSessionState`.

## Agent Runtime Env Checks

- A shell spawned with the env from `buildRuntimeEnv` MUST NOT show any daemon secret (admin token, webhook secrets, third-party API keys, other providers' keys, database URLs) by name or value (`src/runtime/agent-env-policy.test.ts`).
- The Ravi turn env (`RAVI_CONTEXT_KEY`) and the selected managed credential MUST still reach the provider after the filter.
- A provider MUST inherit only its own login variables from the daemon env: Claude gets `CLAUDE_CODE_OAUTH_TOKEN` and not `OPENAI_API_KEY`; Pi gets neither.
- A name under an allowed prefix that looks like a secret (`RAVI_ADMIN_TOKEN`, `GH_TOKEN`, `NODE_AUTH_TOKEN`) MUST be dropped; `SSH_AUTH_SOCK`, `RAVI_STATE_DIR` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` MUST be kept.
- An allowlisted name whose value contains a URL with userinfo MUST be dropped, including an empty user with a password (`http://:pass@host`) and a token as the user (`https://token@host`).
- Provider-scoped config (`CLAUDE_*`, `ANTHROPIC_*`, `CODEX_*`, `PI_*`, `GROK_*`) MUST reach only its own provider; `ANTHROPIC_CUSTOM_HEADERS` MUST be dropped by default and, when passed through, MUST reach Claude only.
- `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` MUST be passed or dropped together; `git config --list` MUST still run in an agent shell when the daemon env carries the trio.
- Names in `RAVI_AGENT_ENV_PASSTHROUGH` MUST reach the provider; names not listed MUST NOT.
- Codex stored-session control MUST spawn without daemon secrets (`src/runtime/codex-control-env.test.ts`).
- `RAVI_*`/`OMNI_*` names MUST pass only from the explicit list: `RAVI_STATE_DIR`, `RAVI_GATEWAY_URL`, `OMNI_API_URL` pass; `RAVI_GATEWAY_INTERNAL`, `RAVI_IDENTITYD_*` and an unlisted `RAVI_SIGNING_SALT` do not.
- `*_PAT` names MUST be dropped; a token-shaped value (`sk-`, `ghp_`, `github_pat_`, `xox…-`, JWT, PEM, `AKIA`) MUST be dropped under any allowed name, and ordinary paths MUST still pass.
- Every job MUST start without daemon secrets, also when actually spawned, whoever created it (`src/jobs/jobs.test.ts`); a name in `RAVI_AGENT_ENV_PASSTHROUGH` still reaches it.
- A provider-prefixed name in `RAVI_AGENT_ENV_PASSTHROUGH` (`CLAUDE_CODE_OAUTH_TOKEN`) MUST NOT reach a job, while an unprefixed one (`DEVIN_API_KEY`) does (`src/jobs/jobs.test.ts`).
- A shell trigger whose owner does not act as the operator MUST NOT run: it is turned off once with one notice that does not carry the command. An operator's shell trigger MUST start from the allowlisted env plus its env file, and MUST run the command stored at fire time, not the one the runner loaded (`src/triggers/__tests__/runner-shell-owner.test.ts`).
- `triggers add --shell`, any `set` on a shell trigger, `enable` and `disable` MUST refuse a local `ravi` with no runtime context, a requester that does not act as the operator, and a requester that is not the trigger's owner (`TRIGGER_SHELL_NOT_OPERATOR`); an env file inside the Ravi state dir MUST be refused (`TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR`), whether reached through a symlink, a symlink followed by `..`, or named with a leading `..` (`..secrets.env`), while a sibling next to the state dir is accepted; an env file with more than one hard link MUST be refused (`TRIGGER_SHELL_ENV_FILE_HARD_LINK`); a FIFO, a device (`/dev/zero`) and a directory MUST be refused as `TRIGGER_SHELL_ENV_FILE_NOT_REGULAR` without blocking, and a missing path under a FIFO MUST NOT block (`src/triggers/__tests__/shell-env-file.test.ts`). A regular env file over 1 MiB MUST be refused as `TRIGGER_SHELL_ENV_FILE_TOO_LARGE` on create and edit, and at fire time MUST turn the trigger off once with one notice, while a file of exactly 1 MiB is accepted. The shared env-file loader MUST refuse a FIFO without blocking, a device, a directory and a file over 1 MiB (`src/cron/shell-executor.test.ts`). The runner MUST NOT run a trigger whose stored env file is refused: it logs the trigger id, turns the trigger off once and sends one notice that names the reason, not the file's content. These are path checks, not an access boundary.
- A directory list (`PATH`, `PKG_CONFIG_PATH`, `MANPATH`) MUST pass whole even when a directory is named like a token; a 200 000-character value MUST be checked in linear time.
- The runtime probe MUST start the provider with the filtered env while it resolves credentials from the whole env (`src/runtime/runtime-probe.test.ts`).
- Every `buildRuntimeRequestEnv` call in the request builder MUST pass `runtimeProviderId` (`src/runtime/runtime-request-builder.env-provider.test.ts`).

## Negative Tests Needed

- Provider emits tool failure then no terminal event.
- Provider emits assistant message after interruption.
- Provider emits terminal event without provider session state.
- Provider emits multiple assistant messages in one turn.
- Provider emits overlapping tool calls.
- Provider exits process without terminal event.
- Provider sends raw status/keepalive forever while turn is logically stuck.

## SDK/Model Update Checks

- Provider SDK version supports the model selector being exposed.
- Direct peer dependencies required by the provider SDK are satisfied.
- New model aliases are covered by provider-local tests.
- Pricing is available through the model catalog or explicitly marked unknown.
- New model capability differences are recorded in provider capability data or a covered provider-local compatibility shim.

## Model Preset Checks

- A preset model selector validates against its immutable provider before commit.
- A referenced preset resolves `effectiveProvider` to the preset provider.
- A preset model update applies on the next turn via direct-set or
  restart-next-turn and traces `agent_preset` plus the new version.

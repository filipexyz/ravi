# Grok Build Provider Rationale

## Why Grok Build Is A Runtime Provider

Grok Build runs local coding-agent sessions through the official `grok` CLI. Ravi already has agent identity, routing, sessions, tasks, traces, contacts, and channel delivery. Treating Grok as a Ravi agent, a Slack/WhatsApp inbound, or Grok Bot would duplicate concepts and blur ownership.

The clean boundary is:

- Ravi agent/session decides what should run.
- Runtime provider executes the turn.
- Ravi host event loop normalizes results, persistence, delivery, traces, and policy.

## Why ACP Instead Of Headless `-p`

Headless `grok -p --output-format streaming-json` is documented for scripts. It is the wrong first adapter for Ravi:

- Each prompt is a new process, so the live `RuntimeSessionHandle` cannot own one native session.
- Interrupt becomes process kill instead of `session/cancel`.
- Resume exists (`--session-id`, `--resume`), but the transport is still one-shot CLI rather than the Pi/Codex RPC pattern.

ACP (`grok agent stdio`) is the IDE/tool integration surface. It gives Ravi a narrow operational boundary that already matches Pi:

- Easy to launch and kill.
- Easy to fixture with a fake JSON-RPC transport.
- Native methods already cover prompting, streamed updates, cancel, and session load.
- Grok internals can evolve without Ravi importing undocumented Bot host gateways.

## Why Not Grok Bot Or The Chat API

Grok Bot is a cloud teammate product. The xAI chat-completions/responses API is a model endpoint, not a coding-agent runtime. Both would violate the provider contract: they are not local execution engines that Ravi can adapt through `RuntimeStartRequest` -> native transport -> `RuntimeEvent`.

## Why Tools Are Ravi-Hosted

Grok has its own tools and ACP permission requests. Ravi remains the authority that allows or denies those tools. Restricted / least-privilege sessions must start, and Grok must not use a tool Ravi did not grant.

`--always-approve` and ACP auto-allow are not a permission model. Grok may also execute some tools without sending `session/request_permission`, so Ravi enforces limits in two places:

- Spawn-time `--allow` / `--deny` / `--tools` materialized from Ravi `canUseTool` grants. `deny` wins even if Grok later tries to auto-run.
- Live ACP `session/request_permission` mapped onto Ravi host services (`authorizeToolUse`, `authorizeCommandExecution` for shell).

Client ACP `fs` / `terminal` methods stay disabled. Ravi is still a runtime adapter, not an IDE host.

## Why Resume Is Session-Id, Not File-Backed

ACP identifies sessions by `sessionId`. Grok also stores headless sessions under `~/.grok/sessions`, but the ACP path does not require Ravi to open those files. The adapter stores the ACP id and cwd, then calls `session/load`. Canonical fork stays false until Ravi prompt-atom mapping exists.

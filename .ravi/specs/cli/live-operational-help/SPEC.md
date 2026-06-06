---
id: cli/live-operational-help
title: "Live Operational Help"
kind: capability
domain: cli
capability: live-operational-help
capabilities:
  - help
  - operational-context
  - permissions-summary
tags:
  - cli
  - help
  - runtime
  - permissions
applies_to:
  - src/cli
  - src/runtime
owners:
  - ravi-dev
status: draft
normative: true
---

# Live Operational Help

## Objective

Make the Ravi CLI act as a live operational skill for agents and humans.

The root `ravi --help` must expose the same operational context contract that is
injected into the built-in agent system prompt. This lets an agent ask the CLI
"how should I operate in this runtime?" and lets an operator debug the same
surface the agent sees.

## Principles

- `--help` is the primary operational contract.
- `--json` is for structured machine consumption after the operator already
  knows which command to run.
- The prompt and CLI help must share one renderer/source of truth.
- The text is Markdown, not JSON.
- Do not print secret context keys or credential values.

## System Prompt Section

Inject a built-in `Ravi Operational Context` section into the runtime system
prompt.

It should include:

- current agent id
- current session name
- current cwd
- channel/chat source when available
- runtime context id when available, never the context key
- a compact permissions/capabilities summary
- the canonical commands for debugging deeper context

The full permissions/tool list can be large. The built-in section should show a
bounded preview and point to `ravi self permissions --json` for the full list.

## Root Help

`ravi --help` should include the same operational section. When the CLI is run
inside an agent context (`RAVI_CONTEXT_KEY`), it should resolve that context in
read-only mode and include the same agent/session/capability summary. Outside an
agent context, it should say that it is running as a direct CLI invocation.

## Debug Commands

The operational section should point agents to:

- `ravi --help`
- `ravi self whoami --json`
- `ravi self context --json`
- `ravi self permissions --json`
- `ravi sessions trace <session>`
- `ravi sessions actions --json`

## Non-Goals

- Do not replace normal command-specific help in this cut.
- Do not dump the full raw system prompt in root help.
- Do not expose secrets.
- Do not implement a complete permission-to-command explanation engine yet.

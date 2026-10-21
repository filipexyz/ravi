---
id: cloud
title: Ravi Cloud
kind: domain
domain: cloud
capabilities:
  - agents
tags:
  - cloud
  - console
  - agents
applies_to:
  - src/cloud-agents
  - src/cli/commands/cloud-agents.ts
  - src/cli/cloud-agents-contract.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Cloud

## Intent

Ravi Cloud is the part of Ravi that runs on the hosted Ravi Console instead of
on the operator's machine. The local install reaches it with the `ravi login`
session; the Console owns the remote state, the provider credentials and who may
do what.

## Rules

- The CLI MUST talk to Ravi Cloud only through the Console's CLI routes
  (`/api/cli/...`) with the `ravi login` credentials; it never calls a provider
  directly.
- Secrets that Ravi Cloud keeps (provider keys) MUST go up once and never come
  back: the CLI reads them from stdin and shows only a hint.
- Every `ravi cloud` command MUST follow the CLI contract (spec `cli`): exit
  codes 0/1/2/3, `--json`, and the write brake for anything that spends money,
  creates provider objects or sends a secret.

## Capabilities

- `cloud/agents`: Library agents running on Anthropic's managed agents with the
  organization's own key.

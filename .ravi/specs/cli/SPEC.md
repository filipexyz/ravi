---
id: cli
title: "CLI"
kind: domain
domain: cli
capabilities:
  - agent-first-ux
  - machine-json
  - listing-contracts
  - cloud-auth
  - watch
  - inbox
tags:
  - cli
  - agents
  - json
applies_to:
  - src/cli
  - src/cli/commands
owners:
  - ravi-dev
status: draft
normative: true
---

# CLI

## Intent

Ravi CLIs are operational tools for humans and agents.

They must be predictable under load, safe to call from runtime, and easy for an
agent to recover from when output is large.

## Invariants

- Machine-consumed commands MUST support `--json`.
- List commands MUST NOT return unbounded data by default.
- Human output SHOULD be compact and show the next useful command.
- JSON output SHOULD expose the same semantic fields across commands when the
  operation shape is the same.
- Commands that can grow with system history SHOULD support pagination,
  filtering, and sorting.
- Dangerous or expensive full-history scans MUST require explicit flags.
- Cloud authentication rules for linking local Ravi to a Console-compatible
  service live in `cli/cloud-auth`.

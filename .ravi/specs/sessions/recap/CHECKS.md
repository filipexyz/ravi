---
id: sessions/recap/checks
title: "Session Recap — Checks"
kind: capability
domain: sessions
capability: recap
status: draft
normative: false
---

# Session Recap Checks

## Projection

- Recap is computed on read. No recap column or table is required.
- Empty or missing history MUST return a valid recap with `recent.items = []`.
- Tool calls MUST be omitted from `recent` (same as `sessions read`).
- The recent tail MUST be bounded. Default 8, max 40.
- `summary`, `pinned`, and `decisions` MUST be empty in v0 unless a later
  persisted source exists. They MUST NOT be LLM-invented.
- `openLoops` MAY include a blocked goal reason and MUST otherwise be empty.
- Session identity MUST include `sessionKey`, `name`, and `agentId`.

## Command

- `ravi sessions recap <nameOrKey>` prints a compact human recap.
- `ravi sessions recap <nameOrKey> --json` prints the recap object on stdout.
- Missing session MUST fail as `SESSION_NOT_FOUND` without suggestions.
- Unauthorized session MUST appear missing (`access session:<id>`).
- A chat attach MUST NOT grant recap permission.

## Session Boundary

- `session.boundary` MUST name `ravi sessions recap --json` alongside
  `sessions read` and `sessions trace`.
- It MUST allow recap of another session only via
  `ravi sessions recap <nameOrKey> --json` with `access session:<id>`.
- It MUST forbid dumping other chats, `MEMORY.md`, and filesystem notes.
- It MUST NOT auto-inject recap text.
- It MUST NOT say agents can never recover context from another session.

## Actions

- `ravi sessions actions --json` MUST include `session.recap` as available.
- `session.recap` is independent of channel capabilities.

## Validation Commands

```bash
bun test src/sessions/recap.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/prompt-builder.test.ts
```

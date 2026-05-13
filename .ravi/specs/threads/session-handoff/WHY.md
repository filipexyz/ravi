---
id: threads/session-handoff
title: "Thread Session Handoff"
kind: capability
domain: threads
capability: session-handoff
status: draft
normative: false
---

# Why Session Handoff

`ravi sessions send --thread` keeps the runtime target explicit while solving context continuity.

Alternatives considered:

- `ravi threads run <thread>`: hides which agent/session continues the work.
- `ravi threads ask <thread>` only: useful later, but too narrow for general continuation.
- automatic agent selection from thread metadata: convenient later, unsafe as a default now.
- Knowledge ingestion first: too heavy for a lightweight operational thread.

The target session is already the place where live runtime execution happens. Adding `--thread` lets Ravi attach portable context without creating a parallel runtime command.

---
id: sessions/goals/why
title: "Session Goals — Why"
kind: capability
domain: sessions
capability: goals
status: active
normative: false
---

# Why Session Goals Control Runtime Goals

Persisting a goal only in Ravi let the UI report `active` while the execution engine retained an older blocked goal. Injecting the objective into a prompt did not enable native continuation after turn completion.

Ravi now defines a common goal contract, and each supporting runtime adapter translates that contract to its native API. The runtime confirms lifecycle and usage; Ravi projects those snapshots and maintains session authorization and local links. Codex is the first implementation, while the CLI and host remain provider-neutral.

Activating a loaded idle Codex thread can immediately start model work. Metadata-only control of an unloaded thread, followed by managed Ravi input, keeps that work within the normal trace and channel-delivery lifecycle.

Tasks continue to own assignment and dependencies. Crons own timed notifications. Goals own a runtime objective and its continuation; these features remain separately inspectable.

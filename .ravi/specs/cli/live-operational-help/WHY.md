---
id: cli/live-operational-help/why
title: "Live Operational Help Why"
kind: capability
domain: cli
status: draft
normative: false
---

Agents and operators need the same answer to three basic questions: which
runtime is active, where the invocation came from, and which capabilities are
actually available. If root help reconstructs those facts independently, it
can disagree with `self` and `context` and turn ambient environment values into
an accidental authority source.

The root operational section therefore reuses the resolved context-registry
record. It keeps invocation source separate from context source, labels legacy
environment fallback, and reports capabilities as unavailable when no
authoritative context exists.

This remains an orientation surface. It does not grant permissions, mutate
context usage timestamps, expose context keys, or replace command-specific
help.

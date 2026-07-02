---
id: apps
title: "Ravi Apps Rationale"
kind: domain
domain: apps
status: active
normative: false
---

# Why Ravi Apps Exist

## Rationale

Ravi already has plugins, skills, CLIs, and tools. Apps fill a structural gap:
a single concept that binds a domain model, machine-readable command surface,
context-bound authorization, durable state, and an agent skill into one
operable unit.

Without apps, each piece lives independently — a CLI has no permission model,
a skill has no manifest, and a plugin has no domain contract. Agents cobble
together capabilities by convention, and operators cannot inspect, audit, or
lifecycle-manage a coherent capability unit.

## Decisions

- Apps are not plugins. Plugins package and discover; apps define operational
  behavior, permissions, storage, and events.
- Apps are not skills. Skills teach agents; apps define the surfaces agents
  operate on.
- Apps are not Ravi Commands. Commands are prompt templates; apps can include
  commands but also CLIs, storage, events, and skills.
- App ids are stable slugs used across manifests, specs, permissions, and
  context keys.
- Scaffold provides the canonical creation path so manifests, specs, skills,
  and permissions start from the same contract.
- The Permission Provider Runtime isolates apps at discovery and execution
  time. Manifest permission declarations are audit metadata, not grants.

## Rejected Alternatives

- Making plugins the app unit: rejected because plugins are packaging
  containers, not operational contracts.
- Making skills the app unit: rejected because skills are teaching artifacts,
  not executable surfaces.
- Auto-exposing every CLI command as an app operation: rejected because debug
  and rare commands should remain CLI-only.

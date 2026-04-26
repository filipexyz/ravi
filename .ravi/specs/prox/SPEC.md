---
id: prox
title: "prox.city"
kind: domain
domain: prox
capabilities:
  - intake
  - people
  - opportunities
  - deals
  - outreach
  - calls
  - runs
tags:
  - prox-city
  - human-orchestration
  - relationships
  - agents
applies_to:
  - ../../../ravi/cognition-hackathon/AGENTS.md
  - ../../../ravi/cognition-hackathon/DEMO.md
owners:
  - ravi-dev
status: draft
normative: true
---

# prox.city

## Intent

`prox.city` is Ravi's product layer for human-centered relationship orchestration.

Ravi is the bot. `prox.city` is the city: people, context, opportunities, agreements, teams, relationships, and human + agent execution.

The core thesis is:

```text
prox.city centralizes people, context, and action so agents can operate relationships without losing sight of the human.
```

## Product Boundary

- `prox` MUST treat humans as the center of the system.
- `prox` MUST model agents as operators around humans, not as replacements for humans.
- `prox` MUST make human approval explicit before material execution, outreach, hiring, payment, or irreversible action.
- `prox` MUST NOT become a generic agent platform namespace.
- `prox` MUST NOT split human orchestration into unrelated feature silos when the concepts belong to the same people/context/action layer.

## Core Loop

The first loop to prove is:

```text
live intake -> person profile -> opportunity match -> hybrid deal -> human approval -> agent execution/handoff -> reviewable output
```

## Conceptual Model

- `person`: the human being.
- `platform_identity`: how a person appears on a channel or external system.
- `profile`: structured capabilities, preferences, limits, availability, and context extracted from intake or history.
- `opportunity`: a concrete need, project, task, collaboration, job, or opening.
- `deal`: an agreement proposal that separates human work, agent work, review, and acceptance criteria.
- `run`: the execution instance after a deal is accepted.
- `artifact`: any durable output generated from intake, matching, execution, or review.

## CLI Shape

The preferred operational namespace is `ravi prox`.

Initial subcommands SHOULD align with:

- `ravi prox people`
- `ravi prox opportunities`
- `ravi prox deals`
- `ravi prox outreach`
- `ravi prox calls`
- `ravi prox runs`

This namespace SHOULD absorb human activation/orchestration surfaces that would otherwise become disconnected modules.

`calls` MUST live under `prox` as an outreach/follow-up capability. Ravi MUST NOT keep a separate top-level `calls` product domain unless a future use case proves it is broader than human relationship orchestration.

## Implementation Status

The current executable prototype lives in `/Users/luis/ravi/cognition-hackathon`.

Ravi core does not yet have `src/prox` or `src/cli/commands/prox.ts`. Those are planned target surfaces, not current implementation.

## Human-In-The-Loop Invariants

- A generated profile MUST be reviewable by a human.
- A proposed match MUST be reviewable by a human.
- A proposed deal MUST be approved before external execution.
- A generated output MUST remain reviewable or rejectable.
- A contact/outreach action MUST respect contact policy, quiet hours, and explicit approval/rules.

## Integration Boundaries

- Contacts and chats provide identity and conversation context.
- Artifacts store durable generated outputs and provenance.
- Tasks or runtime providers MAY execute machine work, but `prox` owns the deal semantics.
- Devin handoff SHOULD go through `ravi devin` as an external execution control plane after human approval, not through direct `prox` API calls to Devin.
- Voice/video providers MAY run intake, but `prox` owns the profile/deal/result semantics.
- Calls are a capability inside `prox`, but calls MUST NOT become the product layer by themselves.

## MVP Focus

For the Cognition hackathon cut, the MVP MUST prioritize:

- a live Agora voice/video intake;
- a visible agent/avatar experience;
- structured profile generation;
- seeded opportunity matching;
- a hybrid deal card;
- Devin handoff after human approval.

## Out Of Scope For The First Cut

- payments;
- full public marketplace;
- real automated outreach at scale;
- multi-user coordination;
- full CRM migration;
- provider-agnostic voice/avatar framework before first E2E success.

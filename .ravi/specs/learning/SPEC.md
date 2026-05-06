---
id: learning
title: "Learning Loop"
kind: domain
domain: learning
capabilities:
  - experience-loop
  - skill-synthesis
  - memory-routing
  - eval-regression
tags:
  - learning
  - skills
  - memory
  - hermes-pattern
applies_to:
  - src/skills
  - src/insights
  - src/tasks
  - src/projects
  - src/runtime
  - .ravi/specs
owners:
  - ravi-dev
status: draft
normative: true
---

# Learning Loop

## Intent

The Learning Loop turns real Ravi work into durable capability. It decides when an experience should become a memory, insight, skill, spec, routine, task profile, eval, or project update.

This domain complements Runtime Quality. Quality detects bad behavior and asks for correction; Learning extracts repeatable capability from both fixes and successes.

## Core Routing Rule

After meaningful work, Ravi MUST route the learning to the right durable surface:

- fact about Luis or a relationship -> memory
- operational pattern or lesson -> insight
- repeatable procedure -> skill
- mandatory rule or invariant -> spec
- recurring trigger-driven process -> routine
- executable work still open -> task
- coordinated workstream -> project
- regression safety -> eval/check

## Invariants

- Learning MUST NOT live only in chat.
- A repeated manual procedure SHOULD become a skill or routine.
- A bug class fixed after investigation SHOULD update a spec, runbook, check, or skill.
- A successful agent workflow SHOULD be reviewed for skill/profile extraction.
- Learning artifacts MUST preserve provenance: source task, session, project, artifact, or incident.
- Learning MUST NOT create new automation that mutates external state without explicit policy and approval boundaries.
- A new skill MUST have a clear trigger description, workflow, validation, and non-goals.
- A new routine MUST define trigger, context acquisition, silence policy, output contract, quality watch, and owner.

## Experience Review Questions

After task completion or incident closure, ask:

1. Did this reveal a new invariant?
2. Did this repeat an old procedure?
3. Did an agent use the wrong skill or no skill?
4. Did this produce a reusable debugging path?
5. Did this require manual state reconstruction?
6. Should future agents be warned before touching this area?
7. Is there a regression check that would have caught this?

## Acceptance Criteria

- A fixed incident can produce a spec/runbook/check update without relying on memory.
- A repeated manual process can be promoted into a skill with validation.
- A recurring scheduled behavior can be expressed as a routine instead of an opaque cron prompt.
- Learning decisions are auditable and linked to source work.

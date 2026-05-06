---
id: learning/skill-synthesis
title: "Skill Synthesis"
kind: capability
domain: learning
capability: skill-synthesis
capabilities:
  - skill-creation
  - skill-update
  - validation
tags:
  - learning
  - skills
  - plugins
applies_to:
  - src/skills
  - src/plugins
  - agents/*/.claude/skills
owners:
  - ravi-dev
status: draft
normative: true
---

# Skill Synthesis

## Intent

Skill Synthesis turns repeated successful procedures into callable agent skills. It is the Hermes-inspired path from experience to reusable capability.

## Invariants

- A synthesized skill MUST have a specific trigger description.
- A synthesized skill MUST include a workflow, validation, and non-goals.
- A synthesized skill MUST NOT embed secrets or volatile local state.
- A synthesized skill SHOULD live in a plugin when it is reusable across agents.
- A synthesized skill MAY live in a workspace only when the capability is intentionally local.
- Updating an existing skill is preferred over creating a near-duplicate skill.
- Skill synthesis MUST check the existing skill catalog for duplicates before writing a new skill.

## Required Skill Sections

- Purpose and trigger
- Inputs/assumptions
- Procedure
- Validation
- Output contract
- Safety boundaries
- Related specs or runbooks

## Validation

Before a skill is considered ready:

- Run the smallest smoke test available.
- Confirm the description would trigger on the intended user request.
- Confirm the skill does not conflict with an existing skill.
- Confirm tool permissions are documented but not silently granted.

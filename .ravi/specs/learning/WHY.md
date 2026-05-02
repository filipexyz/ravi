---
id: learning
title: "Learning Loop Rationale"
kind: domain
domain: learning
status: draft
---

# Why Learning Loop Exists

## Problem

Ravi often learns during real work, but the learning lands in different places: chat, MEMORY.md, AGENTS.md, specs, skills, insights, task comments, or life-review files. Without a routing policy, useful learning becomes local and does not transfer to the next workflow path.

The 2026-04-28 and 2026-04-29 unauthorized agent mutation incidents showed that a lesson recorded locally is not enough. The lesson must be promoted to a global rule or the behavior repeats elsewhere.

## External Pattern

Hermes Agent emphasizes agents that improve by creating skills, routines, and reusable capabilities from work. That is the right pattern, but Ravi should adapt it to its own surfaces: tasks, specs, insights, projects, artifacts, cron/triggers, and runtime skills.

## Design Choice

Learning is modeled as a routing decision, not as one memory bucket.

This prevents every learning from becoming a skill and every fact from becoming a spec. The destination depends on the shape of the learning.

## Tradeoffs

- More durable surfaces means more routing complexity. Mitigation: keep routing rules short and explicit.
- Auto-generating skills can create low-quality clutter. Mitigation: require trigger, workflow, validation, and non-goals before installing a skill.
- Specs can become too broad. Mitigation: only use specs for rules future agents must obey.

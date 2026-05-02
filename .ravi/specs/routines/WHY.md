---
id: routines
title: "Routines Rationale"
kind: domain
domain: routines
status: draft
---

# Why Routines Exist

## Problem

Ravi has cron jobs, triggers, heartbeats, sessions, and tasks, but recurring behavior often lives as a long prompt inside a scheduled job. That makes the behavior hard to review, reuse, test, or monitor.

The state-base blind cron pattern showed that a job can run repeatedly while failing the human outcome. A routine must be monitored at the level of intent, not only execution status.

## External Pattern

Hermes treats routines as first-class recurring agent behavior. Ravi should adapt that pattern while preserving its existing scheduler and trigger surfaces.

## Design Choice

Routine is the semantic layer above cron and triggers.

Cron answers "when." Trigger answers "on what event." Routine answers "what loop is this, what context does it read, what should it output, and how do we know it failed?"

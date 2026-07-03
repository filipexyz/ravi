---
id: routines/proactive-scheduling
title: "Proactive Scheduling Rationale"
kind: capability
domain: routines
capability: proactive-scheduling
status: draft
---

# Why Proactive Scheduling Exists

## Problem

Agents with access to `ravi cron add` tend to over-schedule. Without a concrete decision checklist, agents create vague reminders, duplicate jobs, noisy checks, and speculative automations that generate operational noise without value.

The opposite failure also occurs: agents forget to schedule concrete follow-through steps, causing missed deadlines and lost operational continuity.

## Failure Modes Observed

1. **Over-scheduling** — every task gets a reminder cron, flooding the operator with low-value fires.
2. **Vague reminders** — "check on this later" with no concrete action, time, or success criterion.
3. **Duplicate jobs** — multiple crons covering the same check because the agent did not inspect existing jobs.
4. **Inactivity misrouting** — using cron for silence-based follow-up instead of `ravi sessions followups`.
5. **Policy-in-prompt** — embedding full recurring behavior as a long cron prompt instead of referencing a routine or spec.
6. **Unchecked creation** — creating a cron without verifying its properties via `ravi cron show <id>`.

## Design Choice

A conjunctive six-item checklist forces agents to verify that all conditions are met before creating a cron. This balances follow-through value against noise, and routes each scheduling need to the correct primitive (cron, session followups, shell cron, triggers, or routines).

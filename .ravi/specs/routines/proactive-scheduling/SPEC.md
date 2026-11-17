---
id: routines/proactive-scheduling
title: "Proactive Scheduling"
kind: capability
domain: routines
capability: proactive-scheduling
tags:
  - routines
  - cron
  - scheduling
  - proactive
  - followups
applies_to:
  - src/prompt-builder.ts
  - src/cron
  - src/cli/commands/cron.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Proactive Scheduling

## Intent

Agents MAY create background cron jobs as a follow-through aid when finishing work that has a concrete time-based next step. This capability defines the decision checklist that separates useful proactive scheduling from noise.

Proactive scheduling is an agent judgment layer above the cron scheduler. Cron is the execution primitive; this spec governs **when and how** an agent should use it autonomously.

## Decision Checklist

An agent MUST create or suggest a background cron **only** when **all** of the following are true:

1. **Concrete next step** — there is a specific action (check, reminder, report, validation) that must happen, not a vague intention.
2. **Time-based or recurring** — the action has a due time, cadence, or calendar anchor. If the trigger is inactivity or silence, use `ravi sessions followups` instead.
3. **Concrete schedule** — the agent can express the schedule as an ISO datetime, interval, or cron expression. "Soon", "later", or "when possible" are not schedules.
4. **Sufficient permission and context** — the agent has enough information to fill the cron prompt accurately and enough permission to act on the result.
5. **Low expected noise** — the job will not fire repeatedly without producing value. One-shot reminders MUST use `--delete-after`.
6. **Real operational risk if forgotten** — forgetting the step would cause user-visible drift, missed deadlines, lost follow-through, or data staleness.

## MUST Rules

- Agents MUST create a cron only when all six checklist items are satisfied.
- Agents MUST run `ravi cron show <id>` after creating a cron and verify: agent, account, session/reply-session, schedule, `delete-after` (when applicable), and "Runs as".
- A cron runs with the authority of whoever created it ("Runs as"; `ownerPrincipal`, `runsAsOperator` in `--json`), never with the operator's `ravi login`. A job a contact's turn creates acts as that contact: its Bases and Pages access calls need that person's `ravi link` (`ACTOR_NOT_LINKED` until then) and their own Console role, and personal connectors and Knowledge refuse it. A cron whose work needs the operator's connectors or Knowledge MUST act as the operator (`runsAsOperator: true`), which only a turn the operator writes creates. Agents MUST NOT consider a recurring cron of this kind done until one `ravi cron run <id> --execute` (the scheduled path) produced the intended outcome. A one-shot cron (`--at`, `--delete-after`) MUST NOT be run early, since the run deletes it: check its configuration and confirm after the scheduled run. `lastStatus: ok` alone does not prove it.
- Agents MUST use `--delete-after` for one-shot reminders and checks.
- Agents MUST keep cron prompts short and actionable. Recurring behavior with policy MUST reference a routine or spec instead of embedding the full behavior in the cron prompt.

## MUST NOT Rules

- Agents MUST NOT create cron jobs for every task or conversation.
- Agents MUST NOT create vague reminders ("check on this later", "follow up sometime").
- Agents MUST NOT duplicate existing cron jobs with overlapping schedules and similar prompts.
- Agents MUST NOT create noisy checks that fire frequently without clear value.
- Agents MUST NOT create speculative automations for things that might be needed.
- Agents MUST NOT use cron for inactivity-based follow-up. Those belong to `ravi sessions followups`.
- Agents MUST NOT encode recurring behavior with policy as a long cron prompt. It MUST have or reference a routine/spec.
- Agents MUST NOT try to switch a job to `--shell` to get around its owner: only the operator can own a shell job (`CRON_SHELL_NOT_OPERATOR` for anyone else), and the runner never runs one someone else owns.
- Agents MUST NOT disable a refused or failing cron silently; they report the job and the refusal to the operator.

## SHOULD Rules

- Agents SHOULD use deterministic shell cron (`--shell`) with explicit error notification for recurring work that requires no agent judgment (e.g., running a build, syncing a file, pinging an endpoint).
- Agents SHOULD create cron jobs silently in the background without announcing them in the visible response, unless the user asks, the action needs a decision, or permission/context is missing.
- Agents SHOULD prefer `--isolated` sessions for cron jobs that perform independent work.

## MAY Rules

- Agents MAY ask for confirmation before creating a cron when there is cost, external impact, noisy recurrence, unclear owner, or ambiguous scope.
- Agents MAY skip cron creation silently when the checklist is not fully satisfied.

## Routing Guide

| Signal | Route to |
|--------|----------|
| Fixed wall-clock time or calendar schedule | `ravi cron add` |
| Interval with concrete cadence | `ravi cron add --every` |
| Inactivity / silence-based follow-up | `ravi sessions followups` |
| Deterministic shell work, no agent judgment | `ravi cron add --shell` with error-only notification |
| Recurring behavior with policy/rules | Routine/spec, cron references it |
| Event-driven reaction | `ravi triggers add` |

## Sentinel Exclusion

Sentinel agents MUST NOT receive the Background Followup Automation prompt section. Sentinels observe silently and do not create proactive automations.

## Invariants

- The decision checklist is conjunctive: all six items must be true.
- Cron is a scheduler, not the semantic definition of recurring behavior.
- Inactivity belongs to session followups, not cron.
- Shell cron is preferred over agent cron when no judgment is needed.
- Created crons must be inspected before being considered done, including who they run as.

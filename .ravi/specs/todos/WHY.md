---
id: todos
title: Todos Why
kind: domain
domain: todos
status: draft
---

# Why Todos

## Problem

Ravi has a strong task runtime for executable work, but many everyday commitments are too small or too human-centered for tasks.

Examples:

- "remember to ask Rapha for the zip"
- "make a checklist for my father using the TRT group"
- "things the `trt` agent should verify when a process arrives"
- "follow-ups for this session only"
- "todos assigned to Luis but created from a group"

Using tasks for all of these creates too much ceremony: lifecycle, dispatch, attempts, dependencies, reports, and runtime state. Using free-text chat memory loses queryability and assignment.

## Decision

Create a separate `todos` domain.

Todos are durable, assignable, scoped checklists. They can be promoted to tasks when execution tracking becomes necessary.

## Key Tradeoff

The main design risk is mixing three concepts:

- who owns the list
- where the list belongs
- who should do each item

Those must remain separate or the product will fail in multi-agent and group-chat contexts.

## Relationship To Existing Systems

Todos should integrate with:

- contacts and platform identities for humans
- agents for AI-owned checklists
- sessions/chats for contextual lists
- projects/tasks/workflows for execution context
- tags for classification
- observers for summaries and follow-up

Todos should not replace tasks, projects, routines, tags, or notes.

## Why Not Just Tags

Tags classify assets. They do not create checklist state, completion state, assignees, due dates, or audit trails for an action.

## Why Not Just Tasks

Tasks are execution units. Todos are commitment units.

A todo can become a task. Most todos should not start as tasks.

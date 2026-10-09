---
id: routines/composition
title: "Routine Composition Rationale"
kind: capability
domain: routines
capability: composition
status: draft
---

# Why Routine Composition Works This Way

## Problem

A routine is a loop: something wakes it, it gathers context, runs a protocol, writes state, and decides whether to speak. When those parts stay implicit, routines fire without the context they need, repeat side effects on retry, speak on every run, or lose track of what an approval referred to.

Agents building a solution with Bases and Pages assemble the same parts: a row event wakes a trigger, a view supplies context, a row write is the durable state, and a message or a page is the output. The `solucoes` skill names these parts with six verbs on a sheet the agent fills before building. Two vocabularies for one routine would drift apart, so the sheet maps onto this contract instead of defining a second one.

## Failure Modes Observed

1. **Trigger taken for context.** A row event carries ids and, at most, the values read when it was delivered, never the body or later changes. A routine that acts on the event without reading the row works on stale or missing data.
2. **Approval without a recorded message id.** The reaction arrives, and the routine cannot tell which object it approves.
3. **Retries that duplicate effects.** Writes without processed markers or idempotency keys post, send, or charge twice when a turn is retried.
4. **Live pages for outsiders.** "A portal where customers follow their orders" gets built as a live data page. Pages has no viewer identity for people outside the org, so the page is either public with live data or unreadable by the people it was built for.
5. **One trigger, unrelated outcomes.** A single trigger tries to both notify and update, and every change to one outcome breaks the other.

## Design Choice

- **Separate fields.** Trigger, context, state write, output, and quality are named separately, so a review can ask about each one.
- **People first.** Classifying everyone a routine touches as member or outsider happens before any piece is chosen, because that classification decides which pieces are allowed: a live data page for members, channel messages or snapshots for outsiders.
- **Outsider by default.** Calling an outsider a member exposes data. Calling a member an outsider only costs a less convenient channel.
- **Sheet maps onto fields.** CAPTAR (intake) has no field: intake by machine (a shell cron, a watch) is a separate routine with its own trigger.
- **Naming, not granting.** The sheet names the agent profile a routine needs; granting stays with `ravi agents permissions`.

## Rejected Alternatives

- **A separate spec for the sheet.** It would define a second vocabulary for the same routine.
- **People classification only in skill text.** Skill text is advice. A spec invariant gives reviews and evals a stable rule to check.
- **Classifying people per piece.** The same person would end up a member for the page and an outsider for the message, which is how live data reaches outsiders.

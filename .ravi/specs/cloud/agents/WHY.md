---
id: cloud/agents
title: Cloud Agents Decisions
kind: why
domain: cloud
capability: agents
status: draft
normative: false
owners:
  - ravi-dev
---

# Cloud Agents Decisions

## Why The Organization's Own Key

Cloud runs spend real money. Using the organization's Anthropic key keeps the
bill, the limits and the data agreement with the organization; the Console
stores the key encrypted and the CLI only ever sees its last characters.

## Why The Key Comes From Stdin Only

Arguments end up in shell history, process lists and agent transcripts.
Reading the key from redirected stdin, and only after `--execute`, keeps it out
of all of them; a dry run never touches it.

## Why Spend Is Braked

`runs start`, `runs reply`, `agents deploy`, `tasks dispatch --cloud` and an
enabled schedule all spend the organization's money or create provider
objects. The plan (with `promptChars`, not the prompt) lets an agent show the
operator what will happen before it happens. Stopping, denying, archiving,
removing and disabling only reduce what happens and apply at once.

## Why Approvals Stay With People

A cloud run with `writes: ask` pauses before a write outside its container.
Approving makes the run act as the approver, so an agent turn of someone other
than the operator cannot approve; the watcher relays the request into the
session and tells the agent to show it to the person.

## Why Task Runs Have No Local Assignment

Recovery and checkpoints act on tasks with an active assignment and prompt the
assigned session. A cloud task has no local session working on it, so dispatch
reports progress instead of assigning, and the watcher finishes the task.

## Why Claim Before Deliver

The daemon can restart mid-tick, and ticks can overlap. Claiming the row in
SQLite before the task update and the inform makes the delivery happen once;
reopening on failure keeps it from being lost. The Console acknowledgement is
separate so a Console outage never repeats an inform.

## Why The Result Is Quoted As Untrusted

The run's last message is model output that may have read untrusted pages or
repositories. Quoting it inside `<result>` with the tags neutralized keeps it
from passing as a `[System]` instruction to the receiving session.

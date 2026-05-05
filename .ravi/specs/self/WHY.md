---
id: self/why
title: "Ravi Self Why"
kind: domain
domain: self
status: draft
normative: false
---

# Why Ravi Self Exists

## Problem

Ravi has many context surfaces, but an agent often needs to know its current situation quickly:

- Which agent am I?
- Which session am I in?
- Which chat or route produced this prompt?
- Who is speaking?
- What task/project/thread is active?
- What permissions do I have?
- What should I inspect next?

Today the answer is scattered across sessions, context keys, route records, Omni payloads, contact identity, tasks, projects, events, traces, and soon Knowledge.

That makes agents over-read, under-read, or depend on raw channel details.

## Decision

Create `ravi self` as the canonical agent-friendly self-context command surface.

`self` is not a new store. It is a read-only composition layer.

## Why Not Just `sessions read`

`sessions read` shows conversation/history.

Self should show orientation:

- identity;
- route;
- chat;
- actors;
- work context;
- capabilities;
- relevant knowledge;
- next read commands.

Those are different jobs.

## Why Not Just `context whoami`

`context whoami` identifies the runtime credential.

Self should turn that credential into operational context an agent can use.

It should answer "what does this mean for my next step?", not only "which context key am I using?"

## Why This Belongs Above Omni

Omni owns transport and raw channel facts.

Ravi owns semantics.

Self must keep agents oriented in Ravi concepts so features do not spread WhatsApp JIDs, LIDs, raw Telegram ids, or provider-specific assumptions across the codebase.

## Tradeoff

This creates another CLI namespace.

The cost is justified because it reduces repeated ad hoc context probing and becomes the wedge for Knowledge-backed agent context.

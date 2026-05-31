---
id: sync
title: "Why Local-First Sync"
kind: why
domain: sync
owners:
  - ravi-dev
status: draft
normative: true
---

# Why

Ravi's open-source runtime is valuable because it is local, hackable, and
independent. Requiring Postgres or Console for core data would weaken that
property.

At the same time, CRM, cloud managed runtime, multi-device continuity, and
Console visibility need durable shared state. Event sync gives both:

- local SQLite stays the immediate source of truth for local work;
- remote peers can receive events and build cloud projections;
- multiple installations can converge through inbox/outbox exchange.

This is safer than a database migration because each domain can become syncable
incrementally with explicit conflict policy.

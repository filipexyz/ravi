---
id: permissions/cli-command-access
title: "Why CLI Command Access Exists"
kind: capability
domain: permissions
capability: cli-command-access
---

# Why CLI Command Access Exists

## Decision

Ravi uses a new `@CommandAccess` decorator instead of overloading `@Scope`.

`@Scope` answers a coarse historical question: is this command open, agent,
resource, or admin scoped? It is not expressive enough to describe whether a
command reads state, mutates state, sends an external message, deletes data,
touches credentials, or requires a concrete resource owner.

The Permission Provider Runtime needs a semantic operation contract. That
contract belongs next to the command method so it moves with the implementation
and can be exposed by the registry.

## Why Not Reuse `@Scope`

Using `@Scope("admin")` for every risky command would re-create native
hardcoded policy in the CLI layer. It would also erase useful distinctions
between:

- read vs mutate;
- local state vs external side effect;
- bounded mutation vs destructive mutation;
- command group authority vs resource-specific authority.

The target architecture is provider-owned decision making. Command metadata
declares intent; providers decide.

## Why A Decorator

The CLI already uses decorators and `reflect-metadata` to build the registry,
SDK, OpenAPI, and tool export surfaces. A new decorator keeps the metadata at
the command source and avoids drift from a hand-maintained external table.

This also lets doctor and codegen validate the same source of truth.

## Compatibility

`@Scope` may remain temporarily as compatibility metadata, but it must stop
being a second authorization model. Legacy `execute:group` capabilities can be
accepted by the Permission Provider Runtime during migration; requiring one
after a semantic capability already succeeded creates contradictory denials and
makes least-privilege guidance unusable.

The only retained serial boundary is `superadmin`, because it explicitly marks
operations that must remain behind system-wide break-glass authority even when
their semantic operation is known.

The migration is intentionally incremental: first make intent explicit, then
make provider-runtime enforcement strict.

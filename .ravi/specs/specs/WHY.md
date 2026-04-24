# Ravi Specs / WHY

## Rationale

The system needs a place for durable product and engineering rules that is more structured than scattered notes, but lighter than a database-first policy engine.

Markdown is the source of truth because it is reviewable, diffable, easy for agents to read, and easy for humans to edit. The SQLite index exists only for fast lookup and CLI ergonomics.

The hierarchy is intentionally shallow:

- `domain` captures broad areas like channels, daemon, tasks, or specs.
- `capability` captures reusable subsystems inside a domain.
- `feature` captures concrete behavior that can be validated.

This avoids two failure modes:

- A flat list becomes noisy and agents cannot tell which rule applies.
- A deep taxonomy becomes architecture theater and slows down writes.

## Rejected Alternatives

- Central registry as source of truth: rejected because it duplicates Markdown and creates drift.
- Free-form notes only: rejected because agents need stable ids, kinds, and validation hooks.
- Audit engine in the MVP: deferred because the first useful primitive is reliable retrieval and project linking.

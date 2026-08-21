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

## Facade decision

The agent-first path separates planning, application, and independent
readback without persisting a plan. The caller repeats the normalized intent
with the returned hash, which keeps `plan` a real read and binds later work to
the same workspace, specs root, database, and file contents.

Creation uses a private sibling directory followed by one rename because
cleaning up direct file-by-file writes cannot protect against process crashes.
Missing ancestors are not inferred: their titles, owners, and invariants are
human knowledge. Legacy `new` keeps its established permissive ancestor
behavior, while the facade is strict and exact replay is a visible `noop`.

The complete decision and rejected alternatives are recorded in
`docs/adr/0002-specs-facade-binding-and-atomic-writes.md`.

The approved hash identifies an intended effect, while readback describes what
exists now. Keeping those concepts separate lets the facade reject stale write
authority but still explain a post-apply edit as divergence. Sync likewise
consumes the snapshot that produced its hash; rescanning before the write would
authorize content the caller never reviewed.

Legacy `new` retains its historical ability to populate a directory that was
created in advance and has no `SPEC.md`. That narrow compatibility path cannot
use whole-directory promotion, so the stronger orphan-directory rejection and
atomic quartet guarantee remain facade guarantees.

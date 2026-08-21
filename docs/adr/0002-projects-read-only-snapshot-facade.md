# ADR 0002: Use one read-only snapshot facade for Projects

## Status

Accepted on 2026-08-21 for the Projects read slice.

## Context

The existing Projects reads called services that initialize project, tag,
workflow, task, and router schemas. A command presented as a read could
therefore open SQLite for writing. Exact id/slug collisions and duplicate
resource labels were also resolved by selecting the first row. Finally,
`projects next` returned every enriched project and could exceed one megabyte.

## Decision

All six Projects read operations use `ProjectsReadFacade`. The facade opens the
existing Ravi database once with read-only, no-create semantics, holds one
explicit read transaction while capturing the required project/link/tag/
workflow/node/task state, finalizes every query, and closes the handle.

The facade never creates or migrates a schema. It returns an empty snapshot for
an absent database, a typed schema error for an incompatible existing table,
and typed ambiguity errors instead of selecting a candidate. Read commands opt
out of audit transport under the shared low-risk/effect-none rule.

`projects next` keeps the established ranking but defaults to 20 results and
returns offset pagination.

## Alternatives considered

- Keep calling the service layer and document its schema initialization. This
  was rejected because a hidden write is incompatible with a read contract.
- Open each owner store independently in read-only mode. This was rejected
  because the response could combine different moments and each store would
  need a separate safe-reader contract.
- Remove workflow/task enrichment. This was rejected because it would regress
  the established `show`, `status`, and `next` payloads.
- Keep the unbounded `next` response. This was rejected because context cost
  grows with the full portfolio and transport truncation can masquerade as
  success.

## Consequences

The read path duplicates a small amount of row mapping, but it has one explicit
effect boundary and can be tested without mutating production state. New
columns required by the read contract must be added deliberately. Mutations
remain on the existing services and are outside this ADR.

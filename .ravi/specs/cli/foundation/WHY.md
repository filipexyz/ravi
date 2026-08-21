# Agent-first CLI foundation / WHY

The same defects were found across multiple domain dossiers. Output integrity,
error taxonomy, field validation, pagination validation, and risk discovery are
transport concerns, so fixing them independently in every domain would create
different meanings for the same CLI behavior.

The foundation is deliberately narrow. It does not decide whether a domain
operation is safe, reversible, external, destructive, or authority-bearing. It
provides the language and enforcement points; each domain supplies the facts.

Large-output validation stays in the repository's native process tests. This
exercises the real pipe and termination path without introducing a separate
test-bench methodology or committed bench artifacts.

Backward compatibility is preserved for existing pagination envelopes during
the migration. Cursor pagination is preferred for mutable datasets, but each
domain must define a stable ordering and cursor before switching its public
contract.

Shared numeric pagination no longer clamps values above the declared maximum.
It returns a usage error so callers cannot mistake a different page size for
the one they requested. This is a deliberate public behavior change; response
envelopes and valid values remain compatible.

The foundation starts as `draft`. Reads can be inferred as no-effect, while
legacy mutations remain visibly `unclassified`. Promotion to `active` happens
only after the official gates pass and domain PRs have supplied the real effect
classification and no-effect proofs they own.

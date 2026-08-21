# Specs agent-first CLI contract / WHY

`ravi specs` is the memory agents consult before touching code, so the
contract optimizes the read loop, not write ceremony. Both mutations were
inspected and deliberately left unbraked:

- `new` writes brand-new local Markdown files and REFUSES existing ids
  (`Spec already exists`). There is no overwrite path, so there is nothing
  destructive to brake; failing loud on collision is already the safety.
- `sync` rebuilds the SQLite index FROM the Markdown tree. The index is
  explicitly rebuildable and Markdown remains the source of truth — running
  sync twice is a no-op. More importantly, `sync` is load-bearing
  infrastructure: the CI quality gate calls `syncSpecs()` directly, and
  dozens of spec CHECKS/RUNBOOKs, the README and copilot instructions embed
  `ravi specs sync --json` as a validation step. Braking it would break every
  one of those callers to protect an operation that cannot lose data.

The real gap was not-found quality. `getSpecContext` throws a plain string
error for unknown ids, which surfaced as text + exit 1 with no guidance — and
spec ids are long hierarchical paths (`cli/skills`, `channels/presence/...`)
that agents routinely mistype. `SPEC_NOT_FOUND` now carries bigram
suggestions drawn from the live index, with candidates fetched defensively
(an unreadable index yields empty suggestions rather than a second error).

Enum flags moved to the usage taxonomy: `--mode` and `--kind` have closed
vocabularies, so a wrong value is a caller bug (exit 2 + `acceptedValues`),
not an execution failure. This mirrors the in-body `USAGE_ERROR` precedent
set by `cli` for `--value`.

`--fields` lands on `list` only: `get` returns a single inherited-context
blob whose value is the content itself, while `list` is the scan surface
where agents were dragging full records (path, title, tags, timestamps) just
to see ids and kinds.

The facade does not contradict the unbraked compatibility surface. `plan` is
a real read, and `apply` is an explicitly named local-reversible step bound by
the copied hash. Requiring an additional `--execute` would add ceremony without
creating a second independent decision. Existing `new` and `sync` remain
immediate because CI and established scripts already invoke them directly.

Plans are stateless. Persisting a plan would make a command advertised as read
write to the Ravi database. Repeating normalized input is more verbose, but it
makes the target binding visible and leaves no hidden plan lifecycle to prune.

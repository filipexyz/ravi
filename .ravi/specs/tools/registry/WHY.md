# Tools Registry / WHY

## Rationale

`ravi tools test` calls `tool.handler(args)` and may execute real side effects
despite being annotated as `read/low`. This is unsafe for operators exploring
the registry and for agents that call `tools test` expecting a dry-run.

There is no way to search tools by intent, description, or parameters. Operators
and agents must scan the full list or guess tool names.

## Decisions

- Make `tools test` a dry-run/plan by default. Never call the handler.
- Add `tools invoke` as the explicit execution path with `mutate/high` access.
- Add `tools search` with simple deterministic term matching.
- Keep search local and bounded. No LLM, embeddings, or network calls.
- Preserve all existing runtime enforcement in `tools invoke`.

## Rejected Alternatives

- Adding a `--execute` flag to `tools test`. This overloads test semantics and
  the existing `read/low` annotation cannot be conditionally upgraded.
- Semantic/vector search. Adds complexity and external dependencies for a
  local-first tool.
- Removing `tools test` entirely. It remains useful as a planning surface.

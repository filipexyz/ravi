# Why Devin

Devin is an external execution system. Ravi delegates long-running code tasks to it via
its public API v3 while retaining ownership of routing, task/project linkage, artifacts,
provenance, and operator-facing summaries.

## Key Decisions

- **External executor, not runtime provider.** Devin sessions are long-lived, polled
  execution units. They are not Ravi runtime turns and must not emit fake turn events.
- **Single adapter boundary.** All Devin HTTP access flows through `src/devin/client.ts`.
  No hand-rolled fetch calls elsewhere.
- **Explicit cost controls.** ACU limits come from configuration or explicit CLI flags.
  Ravi must never silently cap or silently unlimit expensive work.
- **Sanitized audit persistence.** The local store records enough metadata to answer
  who created a session, under what identity, with what mode/platform/limits, without
  storing prompt bodies, secret values, or raw auth tokens.
- **Credential safety.** API keys stay in env/secrets. Specs, logs, tasks, artifacts,
  and CLI output must never expose raw token values.

## Alternatives Considered

| Option | Outcome |
|--------|---------|
| Treat Devin as a Ravi runtime provider | Rejected: remote, polled, long-running — does not fit turn semantics |
| Store Devin data in main router DB | Rejected: domain isolation — dedicated `devin.db` is cleaner |
| Infer identity from ambient context | Rejected: impersonation must be explicit per policy |
| Hide low ACU default | Rejected: users must see cost controls before session start |

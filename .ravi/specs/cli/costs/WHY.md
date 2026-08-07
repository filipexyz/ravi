# Costs agent-first CLI contract / WHY

Costs is the surface an agent uses to audit its own spend. The failure mode
that matters here is not a destructive write — it is an expensive read: a
budget check that returns full token/cost breakdowns for every agent and
session can cost more context than it saves. That is why the center of this
migration is `--fields` on the three array payloads (`agents`, `sessions`,
`rows`), not a brake.

The one write path, `pricing --recompute`, rewrites derived pricing metadata
on `cost_events` — recomputable at will from the pricing catalog, and it
already shipped `--dry-run` as its preview flag before this wave. Renaming it
to `--execute` would break the public surface for zero safety gain, so the
pre-existing flag is documented as the brake equivalent instead (the same
decision the ledger records for `--apply`/`--confirm` domains). The decorator
uses `kind: "mutate"` for `pricing`, because authorization is operation-scoped
and the `--recompute` branch writes. To preserve existing least-privilege
agents, exact legacy read grants are migrated to the corresponding mutate
capability; broad read wildcards are not escalated automatically.

Not-found here needed a sharper definition than "resolver returned null".
Cost history legitimately outlives both agent config entries and session
records: a deleted agent or a pruned session still has rows worth auditing.
So the contract only calls something not-found when it resolves to nothing
locally on BOTH axes — no config/record AND no cost event ever. That keeps
the not-found envelope honest without amputating the legacy fallback that
makes `costs session agent:pruned:main` useful.

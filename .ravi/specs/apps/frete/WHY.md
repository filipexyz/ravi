# Frete / WHY

## Decision

Use the current official Olist/Tiny freight quote API instead of porting the
legacy SDE aggregator one provider at a time.

## Rationale

The official Olist contract is public and specifies the exact endpoint, input,
credential header and response. It already quotes against logistics configured
for the account. The legacy `sde frete` command is useful behavior evidence but
mixes Tiny lookups, local J3 price constants, FM v1, GoFretes and client-side
markup. Those private/provider-specific contracts are not all verifiable from
official current documentation in this task.

Choosing the official contract prevents Ravi from freezing undocumented
endpoints or local commercial assumptions into a public SDK.

## Tradeoffs

- Phase 1 does not promise parity for legacy `--markup`, price-list selection,
  or the exact FM/GF/J3 option set.
- The new App requires an Olist integration id and a future Ravi credential
  connection.
- The SDE remains the fallback until read-only parity is evaluated with
  authorized credentials in a later phase.

## Rejected Alternatives

- Native clients for all legacy providers: rejected because FM is explicitly
  deferred and current public contracts for GoFretes/J3 were not confirmed.
- Wrapper around `sde frete`: rejected because the official API is clear and a
  wrapper would keep legacy credential paths and deployment coupling.
- Copying markup/list logic: rejected because those are local business rules,
  not part of the verified provider contract.

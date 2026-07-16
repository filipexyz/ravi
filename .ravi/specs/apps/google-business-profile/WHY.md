# Google Business Profile Ravi App / WHY

## Rationale

`confirmed_official_contract: yes` on 2026-07-13.

The Google Business Profile federated API overview confirms the current resource
model: specialized v1 APIs (Account Management, Business Information, Business
Profile Performance, Verifications) plus the retained Google My Business v4.9
REST reference for reviews, local posts and media. The v1 discovery documents
were fetched without authentication and used as the method/path contract. This
is sufficient to implement a native, portable capability without treating the
external `sde` binary or its token files as the source of truth.

Official sources:

- Federated API overview: <https://developers.google.com/my-business/ref_overview>
- Account Management v1: <https://developers.google.com/my-business/reference/accountmanagement/rest>
- Business Information v1: <https://developers.google.com/my-business/reference/businessinformation/rest>
- Business Profile Performance v1: <https://developers.google.com/my-business/reference/performance/rest>
- Verifications v1: <https://developers.google.com/my-business/reference/verifications/rest>
- Google My Business v4.9 (reviews/posts/media): <https://developers.google.com/my-business/reference/rest>
- OAuth scope: `https://www.googleapis.com/auth/business.manage`

The client is native rather than an `sde` wrapper because the official REST
contract is clear and bounded. It accepts a credential envelope (`clientId`,
`clientSecret`, `refreshToken`) from the Ravi credential broker under provider
`google-business-profile`; secret values never appear in command output or
traces. This lets the structure, command contract, permissions and failure
behavior be tested with a mock transport, without a real credential or any
authenticated request.

## Legacy Gaps Corrected

- Legacy `sde gbp` compiles organization-specific account/location defaults. The
  native app requires explicit account/location resource identifiers on every
  command, so a clean Ravi installation carries no embedded org state.
- Field-specific update wrappers (`update-hours`, `update-service-area`, etc.)
  collapse into one masked `location-update` following the official
  `PATCH v1/{name=locations/*}` contract with an explicit update mask.
- Legacy `config` persistence is dropped: no new DB/file persistence is
  introduced; every operation is provider-owned data or a deterministic
  consumer of it.
- Real `auth-url`/`auth` OAuth onboarding is intentionally not migrated in this
  phase; credentials resolve only through the broker.

## Operation Matrix

The authoritative operation matrix (per-operation category, read/write risk,
official endpoint, migrate/add/ignore decision and source) lives in `SPEC.md`
under "Operation matrix". There are no financial operations in the official or
implemented surface.

## Rejected Alternatives

- **SDE wrapper:** rejected because it would retain legacy token-file coupling
  and organization-specific defaults despite a clear official API.
- **Credential/token import from SDE:** rejected because Phase 1 forbids real
  token use and legacy secret access.
- **Database/cache:** rejected because all outputs are provider-owned data or
  deterministic derivations; persistence adds no lineage needed for Phase 1.
- **Generic raw-request access:** rejected because unmodeled provider endpoints
  must be added as separate bounded operations, never as a raw passthrough.
- **NATS events:** rejected because no new cross-system lifecycle is introduced.

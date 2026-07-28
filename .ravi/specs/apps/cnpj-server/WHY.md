# CNPJ Server / WHY

## Rationale

Agents need a native Ravi surface for bounded company-registry discovery without
depending on a standalone script or inheriting unsafe provider defaults. The
available CNPJ Server is reachable through a private tailnet route, while its
public endpoint does not provide a valid TLS contract. An explicit private
endpoint keeps transport selection visible and prevents accidental fallback or
TLS verification bypass.

The upstream SDK is useful as contract evidence but is not published through
the repository's dependency path, and its default host changed between the
available versions. A small native client gives Ravi one typed boundary,
runtime response validation, stable CLI errors, and generated SDK contracts
without adding a path dependency or vendoring another SDK copy.

CNPJ lookup results may feed CRM writes. Structural validation alone is
insufficient at that boundary: a valid payload for another company, a
contradictory CNPJ segment, or a mismatched search page could otherwise be
accepted under the caller's requested identity. The client therefore
correlates response identity and pagination with the request before any result
can reach CRM export.

## Decisions

- Require the exact private base URL on every network command; do not infer a
  default or offer an insecure transport flag.
- Keep the CNPJ Server integration stateless and read-only. CRM mutation is a
  separate, explicit operation using existing CRM services and authorization.
- Implement the reviewed subset natively instead of importing the unpublished
  SDK by absolute path or copying its package into the monorepo.
- Validate CNPJ check digits before network access and correlate the returned
  complete CNPJ, establishment segments, and company base after parsing.
- Keep search bounded to one requested page and reject a different upstream
  page or more items than the requested limit.
- Make CRM export dry-run by default. Apply requires an exact pinned CNPJ list,
  matching selection hash, owner, and the existing `write_contacts` boundary.
- Create accounts and confirmed CNPJ facts only; do not infer contacts,
  opportunities, or qualification from registry data.
- Reuse the existing CRM account projection for recovery rather than adding a
  table, cache, or duplicate state.

## Rejected Alternatives

- **Use the public endpoint with disabled TLS verification:** rejected because
  it hides an invalid trust boundary and exposes traffic outside the tailnet.
- **Inherit the SDK default host:** rejected because defaults changed across
  versions and can silently select an unreviewed route.
- **Import or vendor the external SDK:** rejected because it would create a
  local-only dependency or a second source of contract truth.
- **Accept any structurally valid company payload:** rejected because payload
  identity must match the caller's selected CNPJ before CRM side effects.
- **Auto-paginate search or export:** rejected because it makes cost and
  selection drift unbounded.
- **Apply CRM writes directly from filters:** rejected because results may
  change between preview and execution.
- **Create contacts or opportunities automatically:** rejected because company
  registry data does not establish a person identity or a qualified deal.
- **Add CRM persistence for imported-company discovery:** rejected because the
  existing account view and source metadata already provide the required
  recovery path.

---
id: apps/console/control
title: "Console Backoffice"
kind: capability
domain: apps
capability: console-control
capabilities:
  - manifest
  - cli
  - ui
  - operations
tags:
  - apps
  - console
  - internal-control
applies_to:
  - src/apps/console/control/ravi.app.json
owners:
  - ravi-dev
status: draft
normative: true
---

# Console Backoffice

## Intent

Console Backoffice is the Ravi App that gives internal operators a single operational surface for Ravi Console user control, organization backoffice, feature access, support intake, and product diagnostics.

This app is intentionally a thin operational wrapper. It MUST NOT own proprietary Console policy, entitlement decisions, WorkOS membership logic, Pages edge provisioning policy, or billing rules. Those rules live in Ravi Console.

## Boundaries

- The Ravi App manifest declares discoverable operations and UI metadata.
- Existing read-only operations MAY call public Ravi CLI commands such as `ravi whoami`, `ravi cloud projects list`, and `ravi pages list`.
- Mutating operations such as granting organization access, inviting a member, changing a feature entitlement, changing a Pages binding, or forcing provider checks MUST call a Console-owned endpoint or CLI contract that performs authorization, validation, idempotency, and audit.
- The OSS app MUST NOT store raw support requests, customer secrets, WorkOS tokens, Cloudflare tokens, email bodies, or proprietary business rules.

## Operator Surfaces

- Users: find a user by authorized operator-visible identity, inspect linked provider identities, memberships, and account state.
- Organizations: inspect organizations, owners/admins, billing account summaries, and current membership state.
- Feature access: inspect effective plan, entitlements, and hidden/internal Console features such as `console.internal_control`.
- Access requests: list, triage, approve, reject, or fulfill organization access requests through Console-owned audited endpoints.
- Product diagnostics: inspect Pages, Channels, Connectors, and GitHub readiness using sanitized provider summaries.
- Audit: show safe operator audit entries for access, feature, Pages, domain, and support actions.

## MVP Operations

- `console.control.check` validates the app manifest.
- `console.control.me` inspects the current Ravi Cloud CLI identity.
- `console.control.users` declares the future user lookup snapshot.
- `console.control.organizations` declares the future organization lookup snapshot.
- `console.control.feature-access` declares the future feature/entitlement snapshot.
- `console.control.access-requests` declares the future access request queue.
- `console.control.projects` lists projects visible to the linked CLI identity.
- `console.control.pages-sites` lists Pages sites for a provided project.
- `console.control.pages-diagnostics` declares the future Pages hostname diagnostic snapshot.
- `console.control.audit` declares the future sanitized operator audit snapshot.
- `console.control.events` declares the internal event stream used by richer operator UIs.

## Planned Console Contracts

The Console-owned implementation currently publishes read-only CLI/API contracts for:

- summarizing the operator dashboard;
- listing feature catalog entries and effective feature access for the current organization;

The Console-owned implementation SHOULD additionally publish contracts for:

- listing and searching users by authorized, sanitized identity fields;
- showing a single user with memberships, linked identities, and effective Console features;
- listing and searching organizations;
- showing a single organization with owners/admins, billing summary, enabled features, and product readiness;
- listing pending access requests;
- resolving an access request by owner approval or explicit support approval;
- inviting or adding a user to an organization with a requested role;
- linking an external identity to an existing organization when the user is already authorized;
- granting or revoking explicit feature entitlements for an organization;
- diagnosing Pages hostnames, custom hostname status, edge provisioning, private-auth return targets, and DNS instructions;
- exposing sanitized operator audit entries.

Suggested endpoint shape:

- `GET /api/cli/internal/control/summary`
- `GET /api/cli/internal/control/users?query=:query`
- `GET /api/cli/internal/control/users/:userRef`
- `GET /api/cli/internal/control/orgs?query=:query`
- `GET /api/cli/internal/control/orgs/:orgRef`
- `GET /api/cli/internal/control/features`
- `GET /api/cli/internal/control/orgs/:orgRef/features`
- `POST /api/cli/internal/control/orgs/:orgRef/entitlements`
- `DELETE /api/cli/internal/control/orgs/:orgRef/entitlements/:featureKey`
- `GET /api/cli/internal/control/access-requests`
- `GET /api/cli/internal/control/access-requests/:id`
- `POST /api/cli/internal/control/access-requests/:id/approve`
- `POST /api/cli/internal/control/access-requests/:id/reject`
- `POST /api/cli/internal/control/orgs/:orgRef/members`
- `GET /api/cli/internal/control/pages/diagnostics?host=:hostname`
- `POST /api/cli/internal/control/pages/bindings/:bindingId/check`
- `GET /api/cli/internal/control/audit`

## Invariants

- The app MUST keep a valid `ravi.app.json`.
- Every mutating operation MUST declare a permission and MUST be enforced again by the Console endpoint.
- Console authorization MUST be the source of truth; app permissions are requirements, not grants.
- Operator-facing responses MUST be sanitized and MUST NOT expose secrets, raw provider tokens, or cross-tenant data.
- Access-grant operations MUST be idempotent by target organization, normalized user identity, role, and request id.
- Feature entitlement operations MUST be idempotent by target organization, feature key, desired state, actor, and reason.
- The app MUST NOT bypass Console APIs with direct SQLite/Postgres/WorkOS/provider writes.

## Validation

- `ravi apps check console/control --json`
- `ravi apps show console/control --json`
- `ravi apps run console/control check --json`

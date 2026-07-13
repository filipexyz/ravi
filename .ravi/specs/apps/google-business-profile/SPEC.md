---
id: apps/google-business-profile
title: "Google Business Profile"
kind: capability
domain: apps
capability: google-business-profile
capabilities:
  - manifest
  - cli
  - operations
tags:
  - apps
  - google-business-profile
applies_to:
  - src/apps/google-business-profile
  - src/cli/commands/google-business-profile.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Google Business Profile Ravi App

`confirmed_official_contract: yes`
`implementation_decision: GO`
`verified_at: 2026-07-13`

## Objective

Provide a native, portable Google Business Profile capability through Ravi CLI,
SDK and Apps. A clean Ravi installation must not require the external `sde`
binary, its token files or organization-specific account/location defaults.

## Contract

- Credentials resolve through Ravi's credential broker under provider
  `google-business-profile` and a caller-selected connection.
- The secret is a JSON envelope containing `clientId`, `clientSecret` and
  `refreshToken`; secret values never appear in command output or traces.
- Every command receives explicit account/location resource identifiers. No
  account, location or website is compiled into Ravi and no new persistence is
  introduced.
- Native Phase 1 operations cover accounts, locations, reviews, local posts,
  media, performance, search keywords, categories, attributes, verifications
  and account/location administrators.
- Read, write and destructive operations have distinct `CommandAccess`
  declarations and manifest permissions. Every mutation requires confirmation.
- Public commands declare a concrete JSON return schema and are generated into
  the TypeScript SDK.
- The App manifest delegates only to native `ravi gbp` commands. App health is
  credential-free manifest validation.

## Official sources

- Federated API overview:
  `https://developers.google.com/my-business/ref_overview`.
- Account Management v1 discovery/reference:
  `https://mybusinessaccountmanagement.googleapis.com/$discovery/rest?version=v1`
  and `https://developers.google.com/my-business/reference/accountmanagement/rest`.
- Business Information v1 discovery/reference:
  `https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1`
  and `https://developers.google.com/my-business/reference/businessinformation/rest`.
- Business Profile Performance v1 discovery/reference:
  `https://businessprofileperformance.googleapis.com/$discovery/rest?version=v1`
  and `https://developers.google.com/my-business/reference/performance/rest`.
- Verifications v1 discovery/reference:
  `https://mybusinessverifications.googleapis.com/$discovery/rest?version=v1`
  and `https://developers.google.com/my-business/reference/verifications/rest`.
- Google My Business v4.9 REST reference for reviews, local posts and media:
  `https://developers.google.com/my-business/reference/rest`.
- Authentication scope for this surface:
  `https://www.googleapis.com/auth/business.manage`.

The official overview confirms the federated API model and retains Google My
Business v4.9 for functionality not moved to specialized APIs. The v1 discovery
documents were fetched without authentication and used as the method/path
contract. No provider operation was executed.

## Operation matrix

| operacao_sde | categoria | risco_read_write | endpoint_ou_recurso_oficial | status_decisao | justificativa | fonte_oficial | observacoes_para_ravi_dev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| auth-url, auth | setup | auth | OAuth 2.0 | aguardar | Real authentication is outside Phase 1. | GBP overview/basic setup | Credential broker only; no legacy token import. |
| config | setup | local-write | none | ignorar | Native commands require explicit account/location resources. | Federated resource model | No new DB/file persistence. |
| health | setup | read | none | migrar | Credential-free app validation is deterministic. | Ravi Apps manifest contract | `ravi apps check google-business-profile --json`. |
| locations, info, account-get | account/location | read | Account Management v1 + Business Information v1 | migrar | Official list/get methods and masks confirmed. | v1 discovery documents | Native `accounts`, `account-get`, `locations`, `location-get`. |
| account-create, account-patch, location-create | account/location | write | v1 create/patch methods | adicionar | Official but rare onboarding operations are not needed for the core Phase 1 surface. | v1 discovery documents | Keep SDE fallback until a dedicated onboarding contract is approved. |
| update-location, update-location-full, update-service-area, update-hours, update-special-hours, update-more-hours | location | write | `PATCH v1/{name=locations/*}` | migrar | One masked native update replaces field-specific wrappers. | Business Information v1 | `location-update`, high risk, confirmation. |
| location-delete | location | destructive | `DELETE v1/{name=locations/*}` | migrar | Official deletion confirmed. | Business Information v1 | Dedicated delete permission and confirmation. |
| reviews, review-get, reviews-summary, reviews-batch | reviews | read | My Business v4.9 reviews list/get/batchGet | migrar | Native list/get cover primary data; summaries remain deterministic consumers. | v4.9 REST reference | `reviews`, `review-get`; batch summary can be added without changing the client contract. |
| review-reply | reviews | public-write | `PUT v4/{review}/reply` | migrar | Official public mutation confirmed. | v4.9 reviews reference | High risk and exact-text confirmation. |
| review-reply-delete | reviews | destructive | `DELETE v4/{review}/reply` | migrar | Official deletion confirmed. | v4.9 reviews reference | Dedicated delete permission. |
| posts, post-get | local-posts | read | My Business v4.9 localPosts list/get | migrar | Official read methods confirmed. | v4.9 localPosts reference | Bounded provider pagination. |
| post-create, post-update | local-posts | public-write | My Business v4.9 localPosts create/patch | migrar | Official public mutations confirmed. | v4.9 localPosts reference | High risk, payload + mask, confirmation. |
| post-delete | local-posts | destructive | My Business v4.9 localPosts delete | migrar | Official deletion confirmed. | v4.9 localPosts reference | Dedicated delete permission. |
| media, media-get | media | read | My Business v4.9 media list/get | migrar | Official read methods confirmed. | v4.9 media reference | Bounded provider pagination. |
| media-create, media-update | media | public-write | My Business v4.9 media create/patch | migrar | Official mutations confirmed. | v4.9 media reference | Source URL/data-ref payload, high risk. |
| media-delete | media | destructive | My Business v4.9 media delete | migrar | Official deletion confirmed. | v4.9 media reference | Dedicated delete permission. |
| media-start-upload, media-customers, media-customer-get | media | read/write | My Business v4.9 media upload/customer resources | adicionar | Official but binary/customer-specific flows need a separate bounded contract. | v4.9 media reference | Legacy remains available. |
| performance, multi-daily-metrics, search-keywords | analytics | read | Performance v1 time-series and monthly keyword methods | migrar | Official read-only reporting methods confirmed. | Performance v1 discovery | Explicit dates/months; no inferred production defaults. |
| categories, category-get, categories-batch | taxonomy | read | Business Information v1 categories | migrar | Core paginated category search is implemented. | Business Information v1 discovery | `categories`; get/batch may be added later. |
| attributes | attributes | read | `GET v1/{name=locations/*}/attributes` | migrar | Official read method confirmed. | Business Information v1 discovery | Native `attributes`. |
| update-attributes, attributes-list, attributes-google-updated, google-updated | attributes/location | read/write | Business Information v1 attribute/update resources | adicionar | Official, but not part of the core location payload contract. | Business Information v1 discovery | Keep explicit permissions when added. |
| verifications, verification-options | verification | read | Verifications v1 list/fetchVerificationOptions | migrar | Official methods confirmed. | Verifications v1 discovery | Medium-risk reads. |
| verify, verification-complete | verification | write | Verifications v1 verify/complete | migrar | Official verification mutations confirmed. | Verifications v1 discovery | High risk and confirmation; PIN redacted. |
| verification-token, voice-of-merchant | verification | read/write | Verifications v1 token/VoiceOfMerchant methods | adicionar | Official specialized endpoints confirmed but not needed for core Phase 1. | Verifications v1 discovery | No endpoint invention. |
| admins, location-admins | access-control | read | Account Management v1 admins list | migrar | Account and location parents share the official Admin model. | Account Management v1 discovery | Native `admins <accounts/...|locations/...>`. |
| admin-add, admin-patch, location-admin-add, location-admin-patch | access-control | write | Account Management v1 admins create/patch | migrar | Official access mutations confirmed. | Account Management v1 discovery | High risk and confirmation. |
| admin-delete, location-admin-delete | access-control | destructive | Account Management v1 admins delete | migrar | Official access removal confirmed. | Account Management v1 discovery | Dedicated delete permission. |
| invitations, invitation-accept, invitation-decline, location-transfer | access-control | write | Account Management v1 invitations/transfer | adicionar | Official, but separate ownership lifecycle needs dedicated HITL semantics. | Account Management v1 discovery | Legacy stays available. |
| notifications, place-actions, lodging, food-menus, chains, google-locations-search | specialized | mixed | Official federated v1/v4 resources | adicionar | Provider contracts are confirmed; specialized workflows are outside the compact core surface. | GBP federated overview + discovery docs | Add as separate bounded operations, never generic raw request. |
| Q&A, Business Calls | deprecated | none | discontinued | ignorar | Official/legacy source marks these services discontinued. | GBP references + legacy evidence | Do not recreate removed endpoints. |

There are no financial operations in the official or implemented surface.

## Non-goals

- Obtaining, importing or testing a real OAuth credential/token.
- Making any authenticated or production request.
- Changing existing agents, grants, skills, schema, NATS events or provider policy.
- Replacing or disabling any `sde gbp` operation.
- Executing Google mutations as part of validation.
- Adding generic raw-request access to unmodeled provider endpoints.

## Validation

- `ravi apps check google-business-profile --json`.
- `bun test src/apps/google-business-profile src/cli/commands/google-business-profile.test.ts`.
- `bun run gen:commands && bun run sdk:generate && bun run sdk:check`.
- `bun run typecheck && bun run build`.
- Mock transport verifies official paths/methods, credential failure and secret
  redaction without authenticated calls.
- Legacy `sde gbp --help` remains present and unchanged.

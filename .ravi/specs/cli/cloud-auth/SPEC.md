---
id: cli/cloud-auth
title: "Cloud Auth"
kind: capability
domain: cli
capability: cloud-auth
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli
  - ravi login
  - ravi whoami
  - ravi logout
  - ravi artifacts publish
tags:
  - cli
  - auth
  - artifacts
  - console
---

# Cloud Auth

## Intent

Cloud Auth lets local Ravi authenticate to a Ravi Console-compatible service so
the CLI can publish local artifacts and operate cloud-scoped project resources.

This open-source spec defines only the local CLI contract and safety rules. The
proprietary server policy for Ravi Cloud, Ravi Pages, billing, quotas, hosted
artifact serving, and private asset auth lives outside this repo.

## Boundary

- The CLI MAY support linking to `console.ravi.bot` or another configured
  Console-compatible base URL.
- The CLI MUST NOT embed WorkOS secrets, Console secrets, provider tokens, or
  Ravi Cloud business policy.
- The CLI MUST treat the Console API as the authority for organization,
  project, artifact publish permission, visibility policy, quotas, and hosted
  URLs.
- The CLI MAY expose generic commands that work against the public Console API
  contract.
- The CLI MUST keep local artifact primitives usable without requiring cloud
  login.

## Commands

The CLI SHOULD support:

```bash
ravi login
ravi login --console https://console.ravi.bot
ravi whoami
ravi logout
ravi projects list
ravi projects link <project>
ravi artifacts publish <artifact-id-or-path> --project <project>
```

Commands consumed by agents MUST support `--json`.

`ravi login` SHOULD open a browser when possible and MUST also print a fallback
verification URL/code for headless or remote environments.

## Auth Flow

The CLI SHOULD implement a browser/device OAuth flow:

1. Fetch public auth config from Console.
2. Start provider login using public client metadata.
3. Display verification URL and user code when provided.
4. Poll or receive completion according to the provider flow.
5. Send the provider access token to the Console exchange endpoint.
6. Store only Ravi-owned CLI credentials returned by Console.
7. Use Ravi CLI access token for API requests.
8. Refresh through Console when the access token expires.

The CLI MUST NOT use browser session cookies as its API credential.

## Local Credential Storage

The CLI SHOULD store refresh credentials in the OS keychain when available.

If a file fallback is required, it MUST:

- live under the user's Ravi config directory;
- be readable and writable only by the current user;
- avoid printing secrets in logs, errors, or JSON output;
- support explicit deletion through `ravi logout`.

The CLI MAY cache non-secret metadata such as:

- Console base URL;
- user email/display name;
- organization id/name;
- local installation id;
- token expiry;
- granted scopes.

## Token Handling

Access tokens SHOULD be short-lived.

Refresh tokens MUST be treated as secrets.

The CLI MUST refresh credentials before retrying an authenticated operation when
the server returns an auth-expired response.

If refresh fails with revoked, reused, or invalid credentials, the CLI MUST
delete local credentials and require `ravi login`.

## Artifact Publish Contract

`ravi artifacts publish` MUST send a structured manifest to Console instead of
letting the server infer arbitrary local filesystem state.

The manifest SHOULD include:

- local artifact id when known;
- title/name;
- summary/description when known;
- version lineage;
- content hash;
- MIME type;
- size;
- relative asset paths;
- source session/agent metadata when safe;
- requested project;
- requested visibility.

Asset paths MUST be relative. The CLI MUST NOT send absolute paths as durable
cloud identity and MUST reject `..` traversal segments.

The CLI SHOULD upload content through the upload mechanism returned by Console.
Large file chunking and resumable upload are deferred until the Console API
specifies them.

## Error Contract

The CLI SHOULD map server errors into stable local messages and exit codes.

Recognized auth/publish errors include:

- `AUTH_REQUIRED`
- `AUTH_PENDING`
- `AUTH_EXPIRED`
- `INSTALLATION_REVOKED`
- `ORG_ACCESS_DENIED`
- `PROJECT_ACCESS_DENIED`
- `PUBLISH_NOT_ALLOWED`
- `PAYLOAD_INVALID`
- `RATE_LIMITED`
- `SERVER_UNAVAILABLE`

Human output SHOULD show the next useful action. JSON output MUST include the
safe error code.

## Acceptance Criteria

- `ravi login` can link a local CLI without storing provider or browser secrets.
- `ravi whoami --json` returns the linked user, organization, Console URL, local
  installation id, scopes, and expiry metadata without exposing tokens.
- `ravi logout` deletes local credentials and asks Console to revoke the session
  when possible.
- `ravi artifacts publish --json` sends a manifest and handles auth refresh.
- Local artifact creation and versioning continue to work offline.

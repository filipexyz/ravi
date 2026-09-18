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
  - ravi link
  - ravi unlink
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
- `ravi login` MUST default to `https://console.ravi.bot` and MUST select an
  alternate Console-compatible service only through the explicit `--console`
  option.
- `ravi login` MUST NOT prompt for, discover, or silently reuse an unrelated
  product endpoint.
- The root auth surface MUST NOT expose a generic `--endpoint` option,
  product-specific installation enrollment, or a post-login provider module.
- An independent product or integration MUST use its own SDK, credentials, and
  login surface instead of repurposing Ravi Console credentials.
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

When Console issues a device `user_code`, the URL that humans and agents open
MUST already include it as the `user_code` query parameter:

`https://<console>/cli/authorize?user_code=<CODE>`

The CLI MUST NOT present the bare `/cli/authorize` page as the link to open.
That page does not bind the pending device grant. If Console omits
`verification_uri_complete`, the CLI MUST construct it from `verification_uri`
plus the issued `user_code` (URL-encoded). The printed code MAY still be shown
as a fallback, but the URL itself MUST already contain it.

`--json` MUST expose the same complete URL on `auth.authorizationUrl` and any
other URL field agents copy (`verificationUriComplete`, `verificationUri`).

## Auth Flow

The CLI SHOULD implement a browser/device OAuth flow:

1. Fetch public auth config from Console.
2. Start provider login using public client metadata.
3. Display the complete verification URL (with `user_code`) and the user code
   when provided.
4. Poll or receive completion according to the provider flow.
5. Send the provider access token to the Console exchange endpoint.
6. Store only Ravi-owned CLI credentials returned by Console.
7. Use Ravi CLI access token for API requests.
8. Refresh through Console when the access token expires.

The CLI MUST NOT use browser session cookies as its API credential.

## Local Credential Storage

The CLI MUST store Console session material (access/refresh JWT used to call
Console and Link as that user) in a **multi-user** store keyed by
`consoleUserId`. A single overwriteable file is not enough.

Linux is the primary target. The store MUST NOT make macOS Keychain the only
backend.

Layout:

```
~/.ravi/cloud-auth/
  active.json                         # { activeUserId, backend } mode 0600
  users/<consoleUserId>/
    credentials.json                  # Console session JWT only, mode 0600
  bindings/<contactId>.json           # identity IDs + TTL, no tokens, mode 0600
```

Directories MUST be mode `0700`. Credential files MUST be mode `0600`.

`ravi whoami` MUST read the **active** user (`activeUserId` pointer). `ravi
login` MUST write that user's slot and update the pointer. `ravi logout` MUST
delete only the active user and, when other users remain, point at another
stored user.

Legacy `~/.ravi/cloud-auth/credentials.json` MUST be migrated into
`users/<consoleUserId>/` (or `users/_legacy/` when the user id is not yet
known) and then removed.

### Secret backends

The CLI MUST use a capability-detected backend abstraction:

1. **Default portable (Linux-first):** `users/<userId>/credentials.json` mode
   `0600`, directory `0700`. This is the default on every OS.
2. **Optional:** FreeDesktop Secret Service / libsecret when `secret-tool` is
   available (`RAVI_CLOUD_AUTH_BACKEND=libsecret` or `auto` on Linux).
3. **Optional:** macOS Keychain when `security` is available
   (`RAVI_CLOUD_AUTH_BACKEND=keychain` or `auto` on Darwin).

`auto` MAY prefer an optional backend when present. Unavailable optional
backends MUST fall back to the portable file store. The CLI MUST never require
macOS.

### Threat model

- The host operator can read local files, including `0600` credentials.
- Connector / provider OAuth tokens (Gmail, Slack, etc.) MUST never be stored
  on disk. Those stay on the `link.ravi.so` Worker.
- Console session JWTs are not provider tokens. They are Ravi-owned CLI
  credentials for Console/Link as that Console user.
- There is no operator JWT fallback for user-scoped connector tools. If a turn
  has a bound `consoleUserId`, those tools MUST use that user's stored
  session (or fail). They MUST NOT silently use the installation operator
  session. Full user-scoped connector vault on the Worker is a follow-up.

The CLI MAY cache non-secret metadata such as:

- Console base URL;
- user id/email/display name;
- organization id/name;
- local installation id;
- token expiry;
- granted scopes;
- TTL'd actor-binding IDs (contact, consoleUserId, orgId).

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
- `HOST_UNREACHABLE` — Console HTTPS failed from a provider sandbox. The host CLI can still reach Console. This is not a generic Console outage and MUST NOT be inferred from unused runtime providers such as `pi`.

Human output SHOULD show the next useful action. JSON output MUST include the
safe error code.

## Acceptance Criteria

- `ravi login` can link a local CLI without storing provider or browser secrets.
- `ravi login` human output and `--json` expose
  `https://<console>/cli/authorize?user_code=<CODE>` as the URL to open whenever
  a device `user_code` exists. The bare `/cli/authorize` URL is never the link
  to follow.
- `ravi login --help` identifies the Console contract and default, does not
  expose `--endpoint`, and the root command does not expose a product-linking
  command.
- `ravi whoami --json` returns the linked user, organization, Console URL, local
  installation id, scopes, and expiry metadata without exposing tokens.
- `ravi logout` deletes local credentials and asks Console to revoke the session
  when possible.
- `ravi artifacts publish --json` sends a manifest and handles auth refresh.
- Local artifact creation and versioning continue to work offline.

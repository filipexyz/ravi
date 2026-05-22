---
id: watch/console-provider
title: "Console Provider Watches"
kind: capability
domain: watch
capability: console-provider
tags:
  - watch
  - console
  - provider-watch
  - inbox
applies_to:
  - src/cli/commands/watch.ts
  - src/watch
  - src/inbox
owners:
  - ravi-dev
status: draft
normative: true
---

# Console Provider Watches

## Intent

Console provider watches let OSS Ravi create and consume always-on provider
watches without owning provider webhooks, provider app secrets, or hosted
normalization logic.

For GitHub, the provider watch is backed by the Ravi GitHub App. The app lives
in Console, receives provider webhooks, verifies them, normalizes them into Ravi
watch events, and delivers those events to local Ravi through inbox.

This is not a Console "bridge" domain. In public OSS specs it is the Console
placement for `ravi watch`.

## Ownership Boundary

- OSS Ravi owns the CLI intent: create/update/list/delete watches, show status,
  and create trigger bindings.
- Console owns provider connection state, provider app installation state,
  webhook ingress, signature verification, provider authorization,
  normalization, provider dedupe, and inbox item creation.
- OSS Ravi MUST NOT store GitHub App private keys, webhook secrets, installation
  access tokens, raw webhook bodies, or provider tokens for Console placement.
- Console-produced watch events MUST be delivered locally through `ravi inbox`.

## Public Console Endpoints

The CLI SHOULD use these Console endpoints for remote watches:

```text
GET    /api/cli/watches/capabilities?provider=<provider>&eventTypes=<csv>
GET    /api/cli/watches/providers/github/installations
GET    /api/cli/watches/providers/github/installations/:installationId/repos
POST   /api/cli/watches
GET    /api/cli/watches
GET    /api/cli/watches/:watchId
PATCH  /api/cli/watches/:watchId
POST   /api/cli/watches/:watchId/enable
POST   /api/cli/watches/:watchId/disable
DELETE /api/cli/watches/:watchId
GET    /api/cli/watches/:watchId/status
```

`installations/:installationId/repos` MAY support `q`, `limit`, and `cursor`.

Provider-specific aliases such as `/api/cli/watches/github/installations` MAY
exist, but new OSS clients SHOULD prefer the provider-neutral paths.

The Console MAY return a provider connection or install URL from the
capabilities endpoint when the provider installation is missing. Watch creation
MUST NOT invent a separate OAuth flow inside the watch API.

## Capabilities Response

`GET /api/cli/watches/capabilities` SHOULD return enough for `--placement auto`:

```ts
type WatchCapabilities = {
  provider: string;
  recommendedPlacement: "local" | "console";
  placements: Array<"local" | "console">;
  supportedEventTypes: string[];
  unsupportedEventTypes?: string[];
  installNeeded?: boolean;
  installUrl?: string;
  connectUrl?: string;
  missingPermissions?: string[];
  missingCapabilities?: string[];
  inboxAvailable: boolean;
  eventTypes?: Record<
    string,
    {
      placements: Array<"local" | "console">;
      requiredCapabilities?: string[];
      requiredProviderPermissions?: string[];
      fidelity?: "full" | "derived" | "best_effort" | "webhook_only";
      webhookOnly?: boolean;
      missing?: string[];
      recommendedPlacement?: "local" | "console";
    }
  >;
};
```

For GitHub webhooks, `auto` SHOULD choose `console` when cloud auth exists,
Console watches are available, the GitHub App installation/repository/permission
checks pass, and inbox delivery is available.

If login, installation, repository selection, permission, or inbox delivery is
missing, `auto` MUST fail with an actionable error. It MUST NOT silently fall
back to local polling for webhook-backed GitHub watches.

## Create Request

`POST /api/cli/watches` SHOULD accept:

```ts
type CreateConsoleWatchRequest = {
  provider: "github" | string;
  placement: "console";
  organizationId?: string;
  projectId?: string;
  providerInstallationId: string;
  providerResourceId?: string;
  providerResource?: {
    owner?: string;
    repo?: string;
  };
  eventTypes: string[];
  filters?: Record<string, unknown>;
  delivery: {
    type: "inbox";
    subscriptionId?: string;
  };
  clientRequestId?: string;
  idempotencyKey?: string;
};
```

Console SHOULD prefer durable Ravi-owned provider ids
(`providerInstallationId`, `providerResourceId`) over raw `owner/repo`.
Raw provider names are useful for UX and lookup, but MUST NOT be the durable
authorization authority when provider ids are available.

The CLI SHOULD send an `Idempotency-Key` header or `clientRequestId`. If an
equivalent active watch already exists, Console MAY return the existing watch as
an idempotent success.

## Watch Record

Console watch responses SHOULD expose:

```ts
type ConsoleWatch = {
  id: string;
  provider: string;
  placement: "console";
  organizationId: string;
  projectId?: string;
  providerInstallationId: string;
  providerResourceId: string;
  providerResourceRef: string;
  eventTypes: string[];
  filters: Record<string, unknown>;
  delivery: { type: "inbox"; subscriptionId?: string };
  status: "active" | "disabled" | "error" | "deleted";
  eventSubjects: string[];
  effectiveEventTypes?: string[];
  missingRequirements?: string[];
  statusUrl?: string;
  lastEventAt?: string;
  lastDeliveryAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
};
```

`eventSubjects` are local trigger topics such as
`ravi.watch.github.pull_request.merged`.

## Inbox Item Contract

Console-hosted watches MUST deliver through the existing inbox envelope on:

```text
ravi.console.inbox.item
```

For watch items:

- `eventType` SHOULD be `watch.<provider>.<event>`, for example
  `watch.github.pull_request.merged`.
- `category` SHOULD be `source_control` for GitHub/source-control watches.
- `source` MUST include safe provider provenance:
  `{ type:"github_webhook", provider:"github", providerEventType, deliveryId,
  providerAction, installationId, repositoryId, repositoryFullName, requestId }`.
- `target` SHOULD be
  `{ type:"github_repository", id:<providerResourceId>, ref:"owner/repo" }`.
- `payload.watch` SHOULD include:
  `{ id, provider, placement, resourceRef, eventTypes? }`.
- `payload` MUST be normalized and minimal.
- `payload` MUST NOT include provider tokens, raw webhook bodies, raw headers,
  webhook secrets, patch bodies, diffs, or private file contents.

The local inbox bridge SHOULD republish a normalized watch event on the matching
`ravi.watch.<provider>.<event>` subject while preserving event identity.

## Dedupe

Console SHOULD dedupe GitHub webhook deliveries by:

```text
github:<installationId>:<repositoryId>:<deliveryId>
```

This provider-level dedupe belongs to raw webhook observability and MUST NOT
collapse fanout to multiple matching watches.

Inbox/watch event dedupe SHOULD include the matched watch:

```text
watch:<watchId>:github:<deliveryId>
```

When provider delivery id is unavailable or unreliable, dedupe MAY fall back to
provider object identity plus action/state, such as:

- pull request number + action + head SHA;
- issue number + action + updated timestamp;
- push ref + after SHA;
- workflow run id + conclusion.

The local inbox bridge MUST preserve `eventId`, `sequence`, `dedupeKey`, and
watch id across replay.

For observability/replay, normalized watch event delivery metadata SHOULD carry
safe origin ids such as `inboxItemId`, `subscriptionId`, `pollId`, and `leaseId`
when available.

## Auth Scopes

Remote watch management SHOULD use watch-specific scopes:

- `console.watches.read`
- `console.watches.write`

Inbox delivery keeps the inbox-specific scopes:

- `console.inbox.read`
- `console.inbox.subscribe`
- `console.inbox.deliver`
- `console.inbox.ack`

Create/update of a Console watch MUST validate active CLI session, active local
installation, organization membership, provider connection, provider
installation/resource authorization, and inbox delivery availability.

## Public Errors

Console watch APIs SHOULD use stable coarse error codes:

- `AUTH_REQUIRED`
- `WATCH_CAPABILITY_UNAVAILABLE`
- `INSTALLATION_MISSING`
- `REPO_NOT_SELECTED`
- `PROVIDER_PERMISSION_MISSING`
- `PROVIDER_CONNECTION_UNAVAILABLE`
- `PROVIDER_RESOURCE_UNAVAILABLE`
- `WATCH_UNSUPPORTED_EVENT`
- `WATCH_ALREADY_EXISTS`
- `WEBHOOK_UNHEALTHY`
- `INBOX_SUBSCRIPTION_MISSING`
- `LOCAL_INSTALLATION_REVOKED`
- `RATE_LIMITED`

Errors MAY include safe actionable fields such as `installUrl`, `connectUrl`,
`missingCapabilities`, or `missingPermissions`.

## Security

Console webhook ingress MUST verify provider signatures before parsing or
trusting payload content. For GitHub this means `X-Hub-Signature-256` and
`X-GitHub-Delivery`.

After signature verification, Console MUST validate:

1. provider installation is active;
2. repository/resource is selected and authorized;
3. provider permissions cover the event family;
4. matched watch is active;
5. local installation/org/project delivery remains authorized.

Raw provider body MAY be used transiently for signature verification and
normalization, but MUST NOT be stored in inbox payloads, logs, or audit records.
If debug evidence is needed, store hashes and safe envelopes only.

## Console Storage Shape

The public contract does not require a specific Console schema, but the expected
server-side shape is:

```text
console_watches(
  id,
  organization_id,
  project_id,
  created_by_user_id,
  local_installation_id,
  provider,
  placement,
  provider_connection_id,
  provider_installation_id,
  provider_resource_id,
  event_types_json,
  filters_json,
  delivery_json,
  status,
  last_event_at,
  last_delivery_at,
  last_error_code,
  created_at,
  updated_at,
  disabled_at,
  deleted_at
)
```

Console SHOULD also keep safe webhook delivery observability linking delivery
id, provider event type, installation/repository ids, matched watch ids, inbox
item ids, and safe error code.

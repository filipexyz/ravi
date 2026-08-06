---
id: cli/slack
title: "Slack CLI Agent Actions"
kind: capability
domain: cli
capabilities:
  - slack
tags:
  - cli
  - slack
  - agent-actions
  - channels
  - agent-first
applies_to:
  - src/cli/commands/slack.ts
  - src/channels/slack
owners:
  - ravi-dev
status: active
normative: true
---

# Slack CLI Agent Actions

## Intent

`ravi slack` is the agent action surface for managing Slack.

It MUST expose Slack-native management actions for agents and operators. It
MUST NOT become a facade for Ravi routing, Omni diagnostics, canonical chat
inspection, or session trace debugging.

Channel management is the primary capability. The CLI MAY call Slack
`conversations.*` methods internally, but the user-facing command language
SHOULD say `channels` when the target is a Slack public/private channel.

## Agent-First Contract (Manual v2)

The `slack` domain follows the shared agent-first contract implemented in
`src/cli/agent-contract.ts`:

- Exit taxonomy: `0` success · `1` execution/not-found error · `2` usage error
  · `3` blocked by policy (write brake / dry-run). Exit 3 is NOT an error — it
  is the system working.
- Write brake (7.8): every externally visible Slack mutation is dry-run by
  default. Without `--execute` the command exits `3` with the
  `WRITE_REQUIRES_EXECUTE` envelope BEFORE any Slack Web API call. The dry-run
  plan carries the Slack method and the exact request `--execute` would send.
- `--execute` MUST be the LAST option of every braked command, and all local
  validation (payload files, access levels, artifact resolution) MUST run
  BEFORE the brake so the plan never promises an impossible write.
- Local resolution (Ravi channel config, credential broker, artifact store,
  local SQLite) MAY run before the brake: it is local. Slack Web API calls MUST
  NOT run before the brake — including reads (`messages-replay` brakes before
  its `conversations.history` fetch).
- Not-found envelopes: `CHANNEL_NOT_FOUND` (Ravi Slack channel config, with
  suggestions from the local config store), `CREDENTIALS_NOT_CONFIGURED`
  (credential broker gap), `MESSAGE_NOT_FOUND` (replay target),
  `CANVAS_NOT_FOUND` (channel canvas resolution), `ARTIFACT_NOT_FOUND` (canvas
  artifact source, with suggestions from the local artifact store). Suggestions
  MUST come only from cheap local sources — never from extra Slack API calls.
- Compact mode (7.9): the main listings (`channels-list`, `channels-history`,
  `files-list`, `canvas-sections-lookup`) accept `--fields a,b,c` and narrow
  the JSON `items` only. `members-list` items are plain user-id strings, so
  `--fields` does not apply there.
- In tool/test context (`hasContext()` true) the contract helpers THROW
  `ContractError` carrying the same envelope and exit code; the dispatcher
  preserves `exitCode`.

## Command Classification (braked vs unbraked)

Braked commands (dry-run by default, `--execute` required, exit 3 before any
Slack Web API call):

| Command | Slack method | Why braked |
|---|---|---|
| `messages-send` | `chat.postMessage` / `chat.postEphemeral` | visible to humans, cannot be reliably unsent |
| `blocks-send` | `chat.postMessage` / `chat.postEphemeral` | visible rich message |
| `blocks-update` | `chat.update` | rewrites a visible message |
| `blocks-showcase` | `chat.postMessage` | posts a showcase message |
| `interactions-respond` | interaction response URL | responds in a live interaction |
| `modals-open` | `views.open` | opens UI for a real user |
| `modals-update` | `views.update` | mutates live UI |
| `modals-push` | `views.push` | mutates live UI stack |
| `work-objects-send` | `chat.postMessage` + metadata | visible message with entity metadata |
| `work-objects-unfurl` | `chat.unfurl` | attaches visible unfurl |
| `work-objects-present-details` | `entity.presentDetails` | renders flexpane for a user |
| `messages-replay` | Ravi channel pipeline | re-ingests and can trigger visible agent output; brake fires before the history read |
| `channels-create` | `conversations.create` | creates a workspace-visible channel |
| `channels-rename` | `conversations.rename` | renames a live channel |
| `channels-invite` | `conversations.invite` | invites real users (they get notified) |
| `canvas-create` | `canvases.create` | creates a visible canvas |
| `canvas-channel-create` | `conversations.canvases.create` | creates a channel canvas |
| `canvas-showcase` | `canvases.edit` | rewrites canvas content |
| `canvas-channel-showcase` | `conversations.canvases.create` + `canvases.edit` | creates/rewrites canvas |
| `canvas-artifact-publish` | `canvases.edit` (replace) | replaces canvas content from an artifact |
| `canvas-edit` | `canvases.edit` | edits canvas sections/title |
| `canvas-access-set` | `canvases.access.set` | changes who can see/edit |
| `canvas-access-delete` | `canvases.access.delete` | revokes access |
| `canvas-delete` | `canvases.delete` | destroys a canvas |

Unbraked commands (reads or purely local operations; no `--execute`):

| Command | Source | Note |
|---|---|---|
| `permissions-list` | `auth.test` | read-only identity/scopes |
| `channels-list` | `conversations.list` | read; supports `--fields` |
| `channels-info` | `conversations.info` | read |
| `channels-history` | `conversations.history` | read; supports `--fields` |
| `messages-inspect` | `conversations.history` + local DB | read/diagnostic |
| `members-list` | `conversations.members` | read; items are id strings (`--fields` n/a) |
| `files-list` | `files.list` | read; supports `--fields` |
| `topology` | `conversations.list` + local router config | read/diagnostic |
| `blocks-validate` | `blocks.validate` | validation-only API call, nothing visible or persisted |
| `work-objects-validate` | local normalization | purely local |
| `canvas-sections-lookup` | `canvases.sections.lookup` | read; supports `--fields` |
| `canvas-artifact-status` | local artifact ledger | purely local |

## Invariants

- `ravi slack` commands MUST be actions over Slack resources, not Ravi
  resources.
- The CLI MUST NOT include default surfaces named `routes`, `chats`,
  `sessions`, or `events` under `ravi slack`; those belong to Ravi/Omni
  commands.
- Every agent-consumed command MUST support `--json`.
- Every list command MUST be bounded and paginated.
- Mutating commands MUST default to dry-run and MUST require `--execute`
  before they call Slack write APIs, exiting `3` with the
  `WRITE_REQUIRES_EXECUTE` envelope otherwise.
- Commands MUST NOT print Slack tokens, signing secrets, auth headers, raw
  secret config, Ravi context keys, or provider session ids
  (`private_metadata` is redacted in modal payloads).
- Slack `ok=false` API responses MUST become actionable errors that explain the
  failed action, likely cause, missing scope/permission when known, and next
  command.
- Not-found failures MUST use the Manual v2 envelope with `suggestions` sourced
  only from cheap local data.
- Writes MUST emit standard CLI audit metadata.

## Output Contract

JSON list output includes `items`, `pagination.limit`, `pagination.cursor`,
`pagination.nextCursor`, and `pagination.hasMore` (Slack cursor provenance).

Braked dry-runs exit `3` and emit the `WRITE_REQUIRES_EXECUTE` envelope whose
`plan` includes:

- the resolved connection and credential source;
- the Slack method that would be called;
- the exact request payload `--execute` would send;
- extra planning context (`item`) when useful (e.g. canvas markdown stats).

## Known Failure Modes

- A Slack CLI that primarily wraps Ravi routes/chats/traces instead of Slack
  actions.
- Message sends that happen during a planning/dry-run step.
- A dry-run that performs a Slack Web API call before braking (regression:
  `messages-replay` fetching history before exit 3).
- A failed Slack API call that prints only `invalid_auth` or `missing_scope`
  without the next corrective action.
- Logging or printing tokens, signing secrets, auth headers, or raw config.
- NOT_FOUND errors that trigger extra Slack API calls just to compute
  suggestions.

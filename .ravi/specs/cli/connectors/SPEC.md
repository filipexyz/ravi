---
id: cli/connectors
title: "Connectors agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - connectors
tags:
  - cli
  - connectors
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - personal-connections
  - turn-classification
applies_to:
  - src/cli/commands/connectors.ts
  - src/cli/commands/gmail.ts
  - src/link/connectors.ts
  - src/link/connector-turn.ts
  - src/link/client.ts
  - src/cloud-auth/connector-auth.ts
  - src/cli/agent-contract.ts
  - src/cli/cloud-error-contract.ts
  - src/cli/remote-gateway.ts
  - src/runtime/turn-origin.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Connectors agent-first CLI contract

## Intent

Make `ravi connectors` and the commands built on it (`gmail`) safe and
reliable for agent consumers. A connection is one person's own external
account (today Google: Gmail and Calendar), owned by a Console user, never by a
project. It serves only its owner's own requests ("Only when I ask"), so every
connector call first classifies the current turn and refuses anyone else's
turn before any Console or Link call. On top of that the commands keep the
agent-first contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on the destructive revoke, and compact discovery.
Connections are remote Console/Link resources, so the not-found surface stays
with the provider (Link/Console errors through the CloudAuthError funnel)
instead of inventing local suggestions that would require extra remote calls.

## Invariants

### Turn classification

1. Every connector helper (`startConnect`, `getConnectStatus`,
   `listConnectors`, `showConnector`, `revokeConnector`, `execCapability`)
   MUST classify the current turn (`src/link/connector-turn.ts`) before it
   reads a Console session. The classification input is the runtime context:
   the CLI context store for in-process tool and gateway calls, otherwise
   `RAVI_CONTEXT_KEY`, otherwise the automation marker
   `RAVI_AUTOMATION_PRINCIPAL` (below). The helper walks `parentContextId`
   (and a projected actor's source context) to the nearest context that
   carries `actorPrincipal`; a chain with no actor anywhere fails closed.
   Every context on the walk, the projected source included, MUST be live: a
   revoked or expired one blocks the call (a child issued during an ended
   turn does not keep that turn's speaker).
2. The only Console session a connector call may use is the active
   `ravi login` session, and only for a turn classified as the operator's.
   Another stored user's session MUST NOT be borrowed, and a non-owner turn
   MUST NOT fall back to the operator session. Without an active session
   every turn fails `AUTH_REQUIRED` before classification, so the logged-out
   owner is never told they are someone else; a contact turn against a stored
   session that does not name its Console user also fails `AUTH_REQUIRED`.
   When the session's refresh fails, the connector call forgets it without
   promoting another stored user (the next call asks for `ravi login`), and
   the Console's `me.user.id` MUST equal the user the turn was classified
   against (otherwise `AUTH_REQUIRED`).
2a. Every process the daemon spawns for an automation (shell cron, shell
   trigger, `ravi jobs run` job) carries
   `RAVI_AUTOMATION_PRINCIPAL=automation:<cron|trigger|job>:<id>`, set after
   the job's env file so it cannot be overridden there. A connector call in
   such a process classifies as that principal, and a session relay it sends
   (`ravi sessions send|ask`) is attributed to that automation, never to
   `automation:operator:local` or `agent:bootstrap`. A context key, when
   present, wins over the marker.
3. The table below is normative. "Allowed" means: use the active session.
   "Blocked" means: throw a CloudAuthError that exits `3` before any remote
   call.

| Turn | Result |
|---|---|
| No runtime context and no runtime or automation marker (terminal) | allowed: speaker `terminal`, conversation `terminal` |
| A live `admin-bootstrap` root context with `admin:system:*` and no actor on the walk (the operator's admin key over the gateway or SDK, and its children) | allowed: speaker `terminal`, conversation `terminal` |
| A runtime marker (`RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, `RAVI_AGENT_ID`, `RAVI_TRIGGER_ID`) or a tool/gateway transport without a live context, or an unresolved/revoked/expired context key, or a revoked/expired context on the walk | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `automation:operator:local` or `agent:bootstrap` relayed by the operator's `ravi sessions send` or `ask` (turn origin `session-relay`, action `send`/`ask`, no session, principal equal to the actor) | allowed: speaker `owner`, conversation `terminal` |
| The same principals with any other origin (`execute`, as the session-goal wake sends, `inform`, `answer`, a relay from a session, or no origin) | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `contact:<id>`, `actorResolution=resolved`, `consoleUserId` equal to the active session's user (and the same org when both are known), in a `dm:` compartment | allowed: speaker `owner` (contactId, consoleUserId), conversation `dm` |
| `contact:<id>` linked to another Console user, not linked, `missing_contact`, or `unknown` | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `agent:<id>` (relay from another agent), `automation:session:*` | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `automation:cron:<jobId>` (agent turn or the job's shell command) | allowed only when the job's `owner_principal` is NULL (legacy), `operator`, or a contact linked to the active Console user and org: speaker `automation`, routine `cron`; otherwise, or when the job is missing, blocked |
| `automation:heartbeat` | allowed: speaker `automation`, routine `heartbeat` |
| `automation:trigger:*`, `automation:job:*`, `automation:observer:*`, `session-followup`, `daemon-restart`, any other principal | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| Compartment `chat:<id>` (group) for a contact turn, the owner included | blocked `CONNECTOR_GROUP_BLOCKED` |
| An allowed routine or relay whose compartment is `chat:<id>` or `dm:<id>` (it answers into a chat) | allowed with conversation `dm` only when every `chats` row for that chat is a `dm` that resolves to one contact linked to the active Console user and org; otherwise blocked `CONNECTOR_GROUP_BLOCKED` |

4. A blocked turn's error message is written for the agent and carries the
   line to say, in `details.chatLine` (English) and `details.chatLinePt`
   (Portuguese), plus `details.replyTo`:
   - group, owner speaking: "I'll send this to you privately." /
     "Vou te mandar isso no privado." and ask the owner to repeat the request
     in their direct chat;
   - anyone else: "I can't use <owner>'s Gmail for your request." /
     "Não posso usar o Gmail de <dono> para o seu pedido." (the owner's name
     comes from the active session; the neutral fallback is "my owner's" /
     "do meu dono"). An unlinked contact also gets the hint that the owner can
     run `ravi link` from their own chat.
   - expired connection (`CONNECTOR_REAUTH_REQUIRED`): "Your Gmail connection
     expired. Reconnect: <console>/connectors" / "Sua conexão do Gmail
     expirou. Reconecte: <console>/connectors", `replyTo: owner_privately`,
     never said in a group, plus `reconnectLink` (the whole link). Public
     messages lose the path of any `scheme://` URL, so the line quoted in the
     message names the page without its scheme
     (`console.ravi.bot/connectors`); `chatLine` and `reconnectLink` keep the
     whole link.
   - approval (`CONNECTOR_APPROVAL_REQUIRED` / `_PENDING`): "Please approve
     this Gmail action: <console>/connectors/approvals/<id>" / "Aprove esta
     ação do Gmail: <link>", `replyTo: owner_privately`, plus `approvalId`,
     `approvalLink`, `expiresAt` and `retryWith: "--approval <id>"`.
5. These local messages and detail keys (`chatLine`, `chatLinePt`, `replyTo`,
   `reconnectLink`, `approvalId`, `approvalLink`, `expiresAt`, `retryWith`)
   reach the public envelope only for errors built locally
   (`details.source == "connector-turn"`). Link and Console errors with the
   same codes keep the fixed catalog copy. Human output prints the chat line
   when the message does not quote it.
5a. The host-gateway relay (child CLIs with `RAVI_CONTEXT_KEY`) keeps that
   copy for `gmail *` and `connectors *`: a `CONNECTOR_*` error that carries a
   chat line keeps its sanitized message (at most 1200 characters, no control
   characters), `chatLine`/`chatLinePt` (at most 300), `replyTo` (only
   `same_chat` or `owner_privately`) and `reconnectLink` (only a Console
   `/connectors` page over https, or http on localhost, with no credentials,
   query or fragment). Other cloud codes on those commands take the local
   catalog message and next step; nothing else of the remote body is kept.
6. `connect`, `list`, `show`, `revoke` follow the same table: no contact can
   connect, list, show or revoke the owner's accounts. The "dono" permission
   tag is not identity.

### Calls

7. `execCapability` MUST send `X-Ravi-Exec-Context`, the base64url JSON of
   `{ v: 1, agentId?, sessionName?, speaker: { kind, contactId?,
   consoleUserId? }, conversation, routine?, turnKey? }` built from the same
   classification. `turnKey` is the sha256 hex of the root turn context id
   (the projected actor's source context when there is one). The header MUST
   NOT exceed 2048 bytes: optional fields are dropped (`sessionName`, then
   `agentId`) until it fits, and an impossible fit fails with
   `PAYLOAD_INVALID`. It never carries message content.
8. `connectors connect` MUST start through the Console:
   `POST /api/cli/connectors/connect/start` with the CLI bearer and body
   `{ provider, accessMode?, reconnectConnectionId?, displayName? }`, then
   poll the Link status `GET /cli/connect/status/:pendingId` until
   `consumed`, `rejected` or `expired` (deadline: the answer's `expiresAt`
   plus a short grace). An answer without `connectUrl`, `pendingGrantId` and
   `expiresAt` is `SERVER_UNAVAILABLE`. The printed URL is the Console
   connect page and the output MUST say that it works only for the Console
   user who started it.
9. `--read-only` sends `accessMode: "read_only"`; `--reconnect <id>` sends
   `reconnectConnectionId`. `--scope` is ignored with a stderr note.
10. `--project` on `connect` and `list` is a no-op until 2027-01-01: it MUST
    NOT be sent and MUST print exactly this line on stderr:
    `--project is ignored: connections belong to you, not to a project (removed after 2027-01-01)`.
11. `list`/`show` return `projectId: string | null` (always null for personal
    connections, kept until 2027-01-01) plus the optional
    `externalAccountLogin`, `isDefault`, `accessMode` (`full` | `read_only`)
    and `scopeKind` (`user` | `organization`); `show` adds optional
    `lastUsedAt` and `revokedAt`. Human output names a connection by its
    account email, never by a project.
12. The default connection for `gmail` without `--connector` is the row
    marked `isDefault` while its status is `active` (Link runs capabilities
    only on active rows, so a degraded, suspended or revoke-pending default is
    skipped), else the newest `active` Google row that does not need
    reauth. When only rows that need reconnecting remain, the command fails
    with the reconnect line (`CONNECTOR_REAUTH_REQUIRED`); with no Google row,
    `CONNECTOR_CONNECTION_REQUIRED`.

12a. Approvals. A Link `connector_approval_required` or
    `connector_approval_pending` answer keeps only `approvalId`
    (`[A-Za-z0-9_-]{1,128}`), `expiresAt` and a short `reason`; the approval
    page is rebuilt as `<console>/connectors/approvals/<id>` from the Console
    of the active login, never taken from Link. `gmail send --approval <id>`
    sends `X-Ravi-Approval: <id>`. At the operator's terminal (a TTY, no
    runtime context, no `--json`) `gmail send --execute` prints the page,
    opens the browser, polls `GET /cli/approvals/:id` every 2 s for up to 10
    minutes and, once approved, sends again with the header; a denial exits 3
    `CONNECTOR_APPROVAL_DENIED`, an expired or used approval exits 1
    `CONNECTOR_APPROVAL_INVALID`, and a timeout returns the approval answer.
    Anywhere else the approval answer exits 3 with the details of
    invariant 4.

### Cron owner

13. `cron_jobs.owner_principal` (TEXT NULL, lazy-init) is set by
    `ravi cron add`: `operator` when the creating turn is the terminal or the
    owner (same table), else the creating turn's `actorPrincipal` (`unknown`
    when it cannot be resolved). NULL means a legacy job and runs as the
    operator. `cron show`/`list` JSON expose it as `ownerPrincipal`, and
    `cron show` prints it as "Runs as". When a turn that is not the operator
    changes a job with `cron set`, any key except `name`, `description`,
    `cron`, `every`, `tz`/`timezone`, `timeout` and `delete-after` (so
    `message`, `shell`, `exec`, `agent`, `session`, `reply-session`,
    `env-file`, `on-error`, `account` and any key added later), the job takes
    that turn's principal as its owner, in the same write as the edit. The
    owner is not part of the `cron add` idempotency fingerprint, so a key
    recorded before owners existed, or an observer replay, still matches.

### Agent-first contract

14. With `--json`, every failure raised by the contract layer MUST return the
    envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
15. Exit codes on contract paths MUST follow the taxonomy: `0` success · `1`
    error · `2` usage error · `3` blocked by policy (write brake and connector
    policy blocks).
16. `connectors revoke` MUST default to dry-run and require `--execute`; the
    dry-run MUST report `dryRun: true` and the `plan` (`{id,
    deletesStoredCredentials}`), and MUST NOT call the Link API. The
    pre-existing `--yes` flag is the documented equivalent of `--execute` (not
    renamed): `--yes` alone still revokes.
17. `connectors connect` is declared UNBRAKED: it is a human-in-the-loop
    browser flow — nothing is granted until the same Console user continues on
    the connect page and consents on the provider page, so an exit-3 plan
    would add friction without preventing any write. `--no-open --json`
    returns one `started` document (`connectUrl`, `pendingGrantId`,
    `expiresAt`, `openAs`) immediately so an agent can surface the URL; a
    waiting flow emits exactly one terminal JSON document.
18. `connectors list` MUST accept `--fields a,b,c` for compact output.
19. A `ContractError` thrown inside a command MUST pass through
    `runConnectorCommand` untouched — the CloudAuthError funnel MUST NOT
    rewrap it (which would corrupt the exit taxonomy).
20. Remote failures preserve their stable CloudAuthError code through the
    global taxonomy: `PAYLOAD_INVALID` exits `2`; the connector policy codes
    exit `3`; other provider/auth failures exit `1`. Link's snake_case codes
    (`connector_group_blocked`, ...) map onto the uppercase CLI codes.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | destructive (deletes stored provider tokens) | dry-run + `--execute` (`--yes` = documented equivalent) |
| connect | human-in-the-loop browser flow on the Console | not braked (declared interactive) |

## Official error cases

| case | code | exit |
|---|---|---|
| braked revoke without `--yes`/`--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| group chat (any speaker) | `CONNECTOR_GROUP_BLOCKED` | 3 |
| someone other than the owner, or an unknown turn | `CONNECTOR_SPEAKER_NOT_OWNER` | 3 |
| organization turned the connector off | `CONNECTOR_DISABLED_BY_ORG` | 3 |
| tool blocked by the owner or the organization | `CONNECTOR_TOOL_BLOCKED` | 3 |
| action needs the owner's approval / still pending / denied | `CONNECTOR_APPROVAL_REQUIRED` / `_PENDING` / `_DENIED` | 3 |
| approval does not match the action | `CONNECTOR_APPROVAL_INVALID` | 1 |
| person asking must consent first (phase 3) | `CONNECTOR_CONSENT_REQUIRED` | 3 |
| person asking is not linked (phase 3) | `CONNECTOR_NOT_LINKED` | 3 |
| no connection for the provider | `CONNECTOR_CONNECTION_REQUIRED` | 1 |
| connection must be reconnected | `CONNECTOR_REAUTH_REQUIRED` | 1 |
| only the connection's owner may do that | `CONNECTOR_FORBIDDEN` | 1 |
| authorization expires before completion | `CONNECTOR_AUTH_EXPIRED` | 1 |
| authorization is rejected (for example opened by another user) | `CONNECTOR_AUTH_REJECTED` | 1 |
| terminal authorization state is invalid | `CONNECTOR_AUTH_STATE_INVALID` | 1 |
| no `ravi login` session (any turn), or a stored session that is not the classified user's | `AUTH_REQUIRED` | 1 |
| other remote/provider errors | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

`gmail` wraps `execCapability`, `listConnectors` and `waitForConnectorApproval`
from `src/link/connectors.ts`; it consumes the helpers, not the braked
`revoke`. `gmail send` is CLI-only, so the approval flow runs in the local
CLI, not over the gateway. There is no shipped
`connectors` skill — lacuna registrada; the CLI `--help`, docs page
`console/connectors` and this spec are the teaching surface.

## Validation

- `bun test src/link/ src/runtime/turn-origin.test.ts src/cloud-auth/connector-auth.test.ts`
  green (classification rows, automation marker, lineage liveness, header
  encoding, connect via the Console, approvals, session pinning). `bun run
  test` runs `src/link/` and `src/runtime/turn-origin.test.ts`.
- `bun test src/cli/commands/connectors.test.ts src/cli/commands/gmail.test.ts src/cli/commands/mail.test.ts src/cloud-auth/errors.test.ts src/cli/remote-gateway.test.ts`
  green (contract describes, `--project` warning, flags, error mapping,
  default connection, gateway relay).
- `bun test src/cron/ src/cli/commands/cron-commands.test.ts src/router/router.test.ts`
  green (cron owner, shell cron marker, idempotency).
- `bun run typecheck` clean.

## Known Failure Modes

- Parser usage errors use the global exit-2 `USAGE_ERROR` envelope because the
  `connectors` root is registered in `AGENT_CONTRACT_DOMAINS`.
- The shared transport boundary MUST normalize the CloudAuthError object's
  historical exit map. Exit `3` is reserved for `WRITE_REQUIRES_EXECUTE` and
  the connector policy codes above.
- Before the rethrow guard, a `ContractError` thrown by the brake was
  rewrapped as `SERVER_UNAVAILABLE` exit 5 by `cloudAuthErrorFromUnknown`,
  silently defeating the taxonomy.
- Before the turn classification, a connector call from a contact's turn used
  the operator's session (or another stored user's session), so anyone who
  could talk to the agent could read the operator's Gmail.
- The runtime marks a turn's compartment `chat:` whenever it has a chat
  surface and the prompt does not say `isGroup: false`. Crons and heartbeats
  that answer into a chat are therefore checked against the `chats` table:
  only the owner's linked direct chat passes.
- TUI turns carry `actorPrincipal: unknown` and are blocked.
- Before the automation marker, shell crons, shell triggers and `ravi jobs
  run` jobs ran without any runtime env (PM2 strips it) and classified as the
  terminal. The marker closes that path, but a shell command written by a
  contact can still unset it itself (`env -u`, a script file); the bash hook
  only blocks literal `RAVI_*` overrides. Closing this fully means refusing
  shell automations created from non-operator turns.
- Before the origin check, the session-goal wake (`execute`, no caller)
  looked like the operator's own `ravi sessions send`.
- Open policy gaps: heartbeat turns have no owner (HEARTBEAT.md can be edited
  from any turn), and legacy crons with a NULL owner run as the operator.
- Other cloud commands still use `getMeWithAutoRefresh` with the default
  delete, which promotes the next stored user after a failed refresh. A
  connector call after such a promotion treats the promoted user as the
  operator; pinning the operator at login is not done yet.

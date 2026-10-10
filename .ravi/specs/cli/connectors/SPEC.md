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
  - agent-mode
applies_to:
  - src/cli/commands/connectors.ts
  - src/cli/commands/gmail.ts
  - src/cli/commands/settings.ts
  - src/link/connectors.ts
  - src/link/connector-turn.ts
  - src/link/connector-mode.ts
  - src/link/client.ts
  - src/cloud-auth/connector-auth.ts
  - src/cloud-auth/errors.ts
  - src/link/open-external.ts
  - src/cli/agent-contract.ts
  - src/cli/cloud-error-contract.ts
  - src/cli/remote-gateway.ts
  - src/runtime/turn-origin.ts
  - src/runtime/turn-reply-target.ts
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
project. By default it serves only its owner's own requests ("Only when I
ask"), so every connector call first classifies the current turn and refuses
anyone else's turn before any Console or Link call. The operator can set an
agent to use, instead, the account of the person asking or an organization
account shared with that agent; those calls go to Link's agent exec, where the
Worker picks the account. On top of that the commands keep the
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
   call. It is the whole table for `connect`, `list`, `show`, `revoke` and
   for an exec in the default `owner` mode; invariant 23 says how an exec
   routes when the agent's mode is `person_asking` or `shared`.

| Turn | Result |
|---|---|
| No runtime context and no runtime or automation marker (terminal) | allowed: speaker `terminal`, conversation `terminal` |
| A live `admin-bootstrap` root context with `admin:system:*` and no actor on the walk (the operator's admin key over the gateway or SDK, and its children) | allowed: speaker `terminal`, conversation `terminal` |
| A runtime marker (`RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, `RAVI_AGENT_ID`, `RAVI_TRIGGER_ID`) or a tool/gateway transport without a live context, or an unresolved/revoked/expired context key, or a revoked/expired context on the walk | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `automation:operator:local` or `agent:bootstrap` relayed by the operator's `ravi sessions send` or `ask` (turn origin `session-relay`, action `send`/`ask`, no session, principal equal to the actor) | allowed: speaker `owner`, conversation `terminal`, when the answer reaches no chat (invariant 3a); a relay whose answer the session posts into a chat follows the last two rows |
| The same principals with any other origin (`execute`, as the session-goal wake sends, `inform`, `answer`, a relay from a session, or no origin) | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `contact:<id>`, `actorResolution=resolved`, `consoleUserId` equal to the active session's user (and the same org when both are known), in a `dm:` compartment whose session is the owner's own (the session check of invariant 23, `readIsPrivateDirectSession`) | allowed: speaker `owner` (contactId, consoleUserId), conversation `dm` |
| The same owner in a `dm:` compartment whose session other people's chats share (`dmScope: main`, a route by session name, another person's chat attached), or whose session is unknown | blocked `CONNECTOR_GROUP_BLOCKED` (`speakerIsOwner`, `sharedSession`) |
| `contact:<id>` linked to another Console user, not linked, `missing_contact`, or `unknown` | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `agent:<id>` (relay from another agent), `automation:session:*` | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| `automation:cron:<jobId>` (agent turn or the job's shell command) | allowed only when the job's `owner_principal` is NULL (legacy), `operator`, or a contact linked to the active Console user and org: speaker `automation`, routine `cron`; otherwise, or when the job is missing, blocked |
| `automation:heartbeat` | allowed: speaker `automation`, routine `heartbeat` |
| `automation:trigger:*`, `automation:job:*`, `automation:observer:*`, `session-followup`, `daemon-restart`, any other principal | blocked `CONNECTOR_SPEAKER_NOT_OWNER` |
| Compartment `chat:<id>` (group) for a contact turn, the owner included | blocked `CONNECTOR_GROUP_BLOCKED` |
| An allowed routine or relay that answers into a chat: its compartment is `chat:<id>` or `dm:<id>`, or its recorded `turnReplyTarget` is a chat, or (a relay) the target was `unresolved` and the session now has an output attachment | allowed with conversation `dm` only when every `chats` row for that chat is a `dm` that resolves to one contact linked to the active Console user and org; otherwise blocked `CONNECTOR_GROUP_BLOCKED` (a relay keeps `speakerIsOwner`) |
| An operator relay with no chat compartment and no readable `turnReplyTarget`, or an `unresolved` one without a session to read | blocked `CONNECTOR_GROUP_BLOCKED`: Ravi cannot tell who reads the answer |

3a. Where a turn's answer goes. The runtime records it on the turn context
   each time a turn starts (`turnReplyTarget`, `src/runtime/turn-reply-target.ts`,
   written in `beforeTurnStart` right after the turn's reply target is bound):
   `none` when the turn posts to no chat (`suppressChatEmit`: a
   `_cliDestination` relay whose CLI waits on the transcript, an
   observation, an observer session); `chat` with the bound chat (`channel`,
   `chatId`, `canonicalChatId`, `instanceId`); otherwise `unresolved` (no
   chat yet, one may be found when the answer is sent). A relay's prompt
   carries no chat unless it names one (`--channel` and `--to`), so its
   compartment is `workspace:default` and says nothing about the answer: the classification reads `turnReplyTarget` from
   the actor context, and checks an `unresolved` one against the session's
   current output attachment (none: the answer reaches no chat). A routine
   takes its compartment from the session's chat, so a recorded chat only
   adds the same check. A relay blocked by where its answer goes keeps
   `speakerIsOwner` (a cron it creates is still the operator's) and `relay`
   (the relay turn, so `connectors mode` still runs from it) and, answering
   into a chat, a candidate with that conversation (`group` unless the chat
   is a known direct chat).

4. A blocked turn's error message is written for the agent and carries the
   line to say, in `details.chatLine` (English) and `details.chatLinePt`
   (Portuguese), plus `details.replyTo`. A block whose code's catalog next
   step would contradict its message (the catalog `CONNECTOR_GROUP_BLOCKED`
   step says to answer in the group) carries its own
   `details.suggestedAction`, which the envelope keeps
   (`src/cli/cloud-error-contract.ts`); the others get the catalog one:
   - group, owner speaking: "I'll send this to you privately." /
     "Vou te mandar isso no privado." and ask the owner to repeat the request
     in their direct chat;
   - the owner's direct chat in a shared session: "I can't use your Gmail in
     this conversation: other people's chats share its session. Give each
     person their own session (dmScope per-peer), then ask me again." / "Não
     posso usar o seu Gmail nesta conversa: as conversas de outras pessoas
     compartilham a sessão dela. Dê a cada pessoa a própria sessão (dmScope
     per-peer) e me peça de novo.", `replyTo: same_chat`; the owner is also
     the operator, so the line says how to allow it. `suggestedAction`:
     "reply in this chat with the chat line, and do not retry until <owner>
     gives each person their own session (dmScope per-peer)";
   - a relay or routine answering into a chat that is not the owner's: no
     chat line; for a relay (also one whose answer Ravi could not place) the
     message says the owner can run the command in their terminal or ask in
     their own direct chat, and `suggestedAction` is "do not retry, and post
     nothing from <owner>'s Gmail into the chat this session answers in;
     <owner> can run the command in their terminal";
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
     `approvalLink`, `expiresAt` and `retryWith: "--approval <id>"`. The
     message tells the agent to send the link to the owner privately, never
     in a group, and to re-run the same command with `--approval <id>` after
     the owner approves.
   - Link answers the person can act on are rebuilt locally the same way
     (the service is named from the capability: `gmail.*` Gmail, `gcal.*`
     Google Calendar):
     - `CONNECTOR_APPROVAL_DENIED`: "Okay, I didn't do it: the approval was
       declined." / "Certo, não fiz: a aprovação foi recusada.",
       `replyTo: same_chat`, and the message says not to run it again;
     - `CONNECTOR_APPROVAL_INVALID`: no chat line; the message says to run
       the same command again without `--approval` to ask for a new one;
     - `CONNECTOR_TOOL_BLOCKED`: "I can't do that: this Gmail action is
       blocked in your Ravi Console settings. You can review it under
       Connectors: <console>/connectors", `replyTo: owner_privately`,
       `reconnectLink` = the Connectors page, and the message says not to
       retry with another flag or connection;
     - `CONNECTOR_DISABLED_BY_ORG` (exec, or the Console connect start):
       "Your organization turned off Google connections in Ravi Console. An
       organization owner or admin can turn them back on.",
       `replyTo: owner_privately`;
     - `CONNECTOR_PERMISSION_REQUIRED` (Link `connector_permission_required`;
       the answer keeps only `accessMode: "read_only"`): read only → "Your
       Gmail connection is read only, so I can't do that. To allow it, choose
       Allow writing in Ravi Console: <console>/connectors"; otherwise "Your
       Gmail connection is missing a permission this needs. Reconnect it in
       Ravi Console: <console>/connectors"; `replyTo: owner_privately`,
       `reconnectLink`.
     At the operator's terminal a denial or an expired/used approval carries
     no chat line: the operator decided it themselves.
5. These local messages and detail keys (`chatLine`, `chatLinePt`, `replyTo`,
   `reconnectLink`, `approvalId`, `approvalLink`, `expiresAt`, `retryWith`,
   `consentLink`)
   reach the public envelope only for errors built locally
   (`details.source == "connector-turn"`). Link and Console errors with the
   same codes keep the fixed catalog copy. Human output prints the chat line
   when the message does not quote it. Detail keys never end in `url`: the
   public sanitizer cuts such values to their origin, so the approval page
   travels as `approvalLink` (the Worker's `approvalUrl` is never kept) and
   the consent page as `consentLink` (the Worker's `consentUrl` is never
   kept).
5a. The host-gateway relay (child CLIs with `RAVI_CONTEXT_KEY`) keeps that
   copy for `gmail *` and `connectors *`: a `CONNECTOR_*` error that carries a
   chat line keeps its sanitized message (at most 1200 characters, no control
   characters), `chatLine`/`chatLinePt` (at most 300), `replyTo` (only
   `same_chat` or `owner_privately`) and `reconnectLink` (only a Console
   `/connectors` page over https, or http on localhost, with no credentials,
   query or fragment). An approval answer also keeps `approvalId` (only one
   matching `[A-Za-z0-9_-]{1,128}`), `approvalLink` (only that id's Console
   `/connectors/approvals/<id>` page, under the same link rules),
   `retryWith` (only exactly `--approval <id>`) and `expiresAt` (only a
   parseable date, at most 64 characters). A `CONNECTOR_CONSENT_REQUIRED`
   answer also keeps `consentLink` (only a Console
   `/connectors/consent/<token>` page, token `[A-Za-z0-9_-]{16,256}`, under
   the same link rules) and `expiresAt`. Other cloud codes on those
   commands take the local catalog message and next step; nothing else of
   the remote body is kept.
6. `connect`, `list`, `show`, `revoke` follow the same table: no contact can
   connect, list, show or revoke the owner's accounts. The "dono" permission
   tag is not identity.

### Calls

7. `execCapability` MUST send `X-Ravi-Exec-Context`, the base64url JSON of
   `{ v: 1, agentId?, sessionName?, speaker: { kind, contactId?,
   consoleUserId? }, conversation, routine?, turnKey?, agentDisplayName? }`
   built from the same classification. `turnKey` is the sha256 hex of the
   root turn context id (the projected actor's source context when there is
   one). The header MUST NOT exceed 2048 bytes: optional fields are dropped
   (`agentDisplayName`, `sessionName`, then `agentId`) until it fits, and an
   impossible fit fails with `PAYLOAD_INVALID`. It never carries message
   content. On agent exec (invariant 23) `speaker.consoleUserId` is never
   sent and `agentId` is never dropped: a header that does not fit without it
   fails `PAYLOAD_INVALID`.
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
11. `list`/`show` return `projectId: string | null` (kept until 2027-01-01
    and ignored by the CLI: the Worker sends a string, the row's project,
    else the stored legacy project id, else `""`; older answers sent null)
    plus the optional
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
    `connector_approval_pending` answer (409) keeps only `approvalId`
    (`[A-Za-z0-9_-]{1,128}`), `expiresAt` and a short `reason`; the approval
    page is rebuilt as `<console>/connectors/approvals/<id>` from the Console
    of the active login, never taken from Link. `--approval <id>` on
    `gmail send`, `gmail list` and `gmail read` sends `X-Ravi-Approval: <id>`
    (a read tool the owner set to Needs approval asks the same way); a value
    outside the id pattern fails `PAYLOAD_INVALID` before any call. Every
    gmail exec goes through `execCapabilityWithApproval`
    (`src/link/connectors.ts`):
    - At the operator's terminal (stdin and stdout are TTYs, no runtime
      context as defined by invariant 1, no `--json`), a required or pending
      approval prints the page on stderr, opens the browser with the same
      helper as `ravi login` (`src/link/open-external.ts`, best effort),
      polls `GET /cli/approvals/:id` every 2 s for up to 10 minutes and, once
      `approved`, runs the same exec (same body) once more with the header.
      Poll answers: `denied` → exit 3 `CONNECTOR_APPROVAL_DENIED`; `expired`,
      `consumed`, an unknown status, or a 404 → exit 1
      `CONNECTOR_APPROVAL_INVALID`; a retryable failure (5xx, 429) keeps
      waiting; an expired bearer is refreshed once; after 10 minutes the
      approval answer is returned (exit 3).
    - Anywhere else the approval answer exits 3 with the details of
      invariant 4 and is not polled.
    - A step-up challenge (Link `connector_stepup_required`) on `gmail send`
      is answered at the operator's own terminal only, and the step-up retry
      keeps the approval header: the Worker asks for the step-up before it
      consumes the approval, so the owner approves once. In a runtime turn
      (an agent, the gateway) the step-up never opens a browser or reads
      stdin: the command exits 3 `INTERACTIVE_ONLY`.
    - A re-run with `--approval` that Link answers with
      `connector_approval_denied` (403) exits 3, with
      `connector_approval_invalid` (400) exits 1, with the copy of
      invariant 4.

### Cron owner

13. `cron_jobs.owner_principal` (TEXT NULL, lazy-init) is set by
    `ravi cron add`: `operator` when the creating turn is the terminal or the
    owner (same table; also the owner blocked only by where the answer goes:
    a group, a shared session, a relay answering into a chat), else the
    creating turn's `actorPrincipal` (`unknown` when it cannot be resolved).
    NULL means a legacy job and runs as the operator. `cron show`/`list` JSON
    expose it as `ownerPrincipal`, and `cron show` prints it as "Runs as".
    When a turn that is not the operator changes a job with `cron set`, any
    key except `name`, `description`,
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

### Per-agent mode

21. Each agent has one mode per provider (today only `google`), stored in the
    settings table under `connectors.mode.<agentId>.<provider>`
    (`src/link/connector-mode.ts`): `owner` ("Only when I ask", the default),
    `person_asking` ("The person asking") or `shared` ("Shared account"). A
    missing, unreadable or unknown value is `owner`. `owner` is stored as no
    row.
22. `ravi connectors mode <agent> <provider> [owner|person-asking|shared]`
    shows the mode without a value and sets it with one (`person_asking` is
    accepted too). In this order: the turn MUST be the operator's (the
    terminal, the owner's own linked direct chat, also when its session is
    shared, since a mode change returns nothing from an account, or the
    owner's own `ravi sessions send|ask`, for the same reason wherever the
    session posts its answer), otherwise exit 3 `CONNECTOR_SPEAKER_NOT_OWNER`
    with the chat line "Only <owner> can change that." / "Só <dono> pode
    mudar isso." and nothing is read or written. The owner asking outside
    their direct chat (a group) is refused the same way, with
    `CONNECTOR_GROUP_BLOCKED` in a group, and the chat line "Ask me in our
    private chat and I'll change it." / "Me peça no nosso chat privado que eu
    mudo."; then an unknown provider or
    mode is exit 2 `USAGE_ERROR` with `acceptedPositionals`; an unknown agent
    is exit 1 `AGENT_NOT_FOUND` with suggestions; setting the current value
    changes nothing (exit 0, `changed: false`). Moving to `person-asking` or
    `shared` is braked: without `--execute` it exits 3
    `WRITE_REQUIRES_EXECUTE` with the plan `{agentId, provider, from, to,
    affects}` and writes nothing. Moving to `owner` only narrows who reaches
    an account and applies at once. The mode is read from SQLite on every
    connector call, so no refresh event is needed. `ravi settings set` and
    `ravi settings delete` MUST refuse `connectors.mode.*` keys, so neither
    the operator check nor the brake can be skipped; `settings get|list` may
    show them (the value only names a mode). Deleting an agent
    (`dbDeleteAgent`) MUST delete its `connectors.mode.<agentId>.<provider>`
    rows (exactly that agent's: `a` never takes `a.b`'s), so an agent created
    again with the same id starts at `owner`.
23. Routing (`resolveConnectorExecRoute`, used by `execCapability` and
    `resolveConnectorExecPlan`): the turn is classified with the table of
    invariant 3, then the executing agent's mode decides where an exec goes.
    `owner` mode uses `POST /cli/exec/:connectorId`; the other modes use
    `POST /cli/agent-exec` with body `{ provider, capability, parameters,
    mode }`, where the Worker picks the connection.

    Every turn the owner table allows is the owner's own request and keeps
    the owner's connection in every mode; only `--shared` moves one of them.

| Turn | `owner` | `person_asking` | `shared` |
|---|---|---|---|
| Terminal, operator relay (`ravi sessions send\|ask`) answering to no chat | own connection | own connection | own connection (`--shared`: `PAYLOAD_INVALID`) |
| The owner's own direct chat (a session of its own), or an operator relay answering into it | own connection | own connection | own connection; agent exec `shared`, conversation `dm`, with `gmail --shared` |
| The owner's own direct chat whose session other people share | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED`; agent exec `shared`, conversation `dm`, with `--shared` |
| An operator relay answering into a group or another person's chat | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED`; agent exec `shared` with that conversation, with `--shared` |
| The owner in a group | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED`; agent exec `shared`, conversation `group`, with `--shared` |
| A resolved contact (linked to another user, or not linked) in a direct chat with a session of their own | `CONNECTOR_SPEAKER_NOT_OWNER` | agent exec `person_asking` | agent exec `shared`, conversation `dm` |
| A resolved contact in a direct chat whose session other people share | `CONNECTOR_SPEAKER_NOT_OWNER` | `CONNECTOR_GROUP_BLOCKED` ("I can't use your Gmail in this conversation.") | agent exec `shared`, conversation `dm` |
| A resolved contact in a group | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED` ("I can only use your Gmail in a direct chat with me. Ask me there.") | agent exec `shared`, conversation `group` |
| A routine the table allows (operator cron, heartbeat), posting nowhere or into the owner's direct chat | own connection | own connection | own connection (`--shared`: `PAYLOAD_INVALID` when it posts nowhere; agent exec `shared`, conversation `dm`, in the owner's direct chat) |
| A routine answering into a chat that is not the owner's direct chat | `CONNECTOR_GROUP_BLOCKED` | `CONNECTOR_GROUP_BLOCKED` | agent exec `shared` with that conversation |
| An unresolved sender, another agent, a trigger, observer, job, an ended or unknown turn | blocked | blocked | blocked |

    A direct chat has a session of its own (`readIsPrivateDirectSession`)
    when the turn's contexts name one session key, that key parses as a
    direct-chat key (`peerKind: dm`, never `dmScope: main`), no active route
    sends chats into it by name (`routes.session_name`), and every active
    `session_chat_subscriptions` row of it (inbound routing attaches each
    chat it sends there) is the speaker's own direct chat: the compartment's
    chat, or a `dm` chat that resolves to the same contact. Anything else,
    or a failed read, is not private: in `person_asking` the person's mail
    would stay in a transcript other people can ask about.

    `--shared` (on `gmail list|read|send`) works only on the owner's own
    turns in a chat (conversation `dm` or `group`), because a shared grant
    only lists chats. On an agent that is not in `shared` mode, with no agent
    (the terminal), or on a turn whose conversation is `terminal` or
    `automation` (the operator relay answering to no chat, a routine posting
    nowhere), it is
    `PAYLOAD_INVALID` (exit 2); on anyone else's turn it never unblocks
    anything. In agent modes `--connector` is refused with
    `PAYLOAD_INVALID` (it names one of the owner's own connections), and the
    exec pins the mode it planned: if the mode changed in between, the exec
    fails `CONFLICT` before any call.
24. The agent exec header carries `agentId`, `agentDisplayName` (the agent's
    name, at most 120 characters), and for a contact only
    `speaker.contactId`. It never carries `consoleUserId`: the Worker takes
    the person from its own `ravi link` binding. The CLI bearer is still the
    operator's session.
25. Agent exec answers are rebuilt locally for the person in the chat, never
    the owner (`replyTo: same_chat`). The consent, not-linked,
    connection-required, forbidden, group-blocked, approval, denial,
    tool-blocked and disabled-by-org answers exit 3; the permission and
    reconnect answers keep exit 1 (invariant 4); an approval that no longer
    matches stays `CONNECTOR_APPROVAL_INVALID` exit 1:
    - `connector_consent_required` (409) → `CONNECTOR_CONSENT_REQUIRED`. Link
      keeps only the token of `consentUrl` (path
      `/connectors/consent/<[A-Za-z0-9_-]{16,256}>`) and `expiresAt`; the
      page is rebuilt as `consentLink = <console>/connectors/consent/<token>`
      from the Console of the active login. Chat line "To use your Gmail
      here, approve it once: <link>" / "Para eu usar o seu Gmail aqui, aprove
      uma vez: <link>". The message refers to the chat line instead of
      quoting the link, says to send it only in that direct chat, and to run
      the same command again after they approve. Without a usable token the
      error has no chat line and says to run the command again.
    - `connector_not_linked` (403) → `CONNECTOR_NOT_LINKED`: "To use your
      Gmail here, first link this chat to your Ravi account. Want me to send
      you a private link to do it?" (PT: "Para eu usar o seu Gmail aqui,
      primeiro vincule este chat à sua conta Ravi. Quer que eu te mande um
      link privado para isso?"). The chat line names no command; the message
      tells the agent to run `ravi link` in their turn if they say yes. With
      reason `speaker_not_member`: "I can't use your Gmail here: your Ravi
      account is not part of this organization."
    - `connector_connection_required` (409) → `CONNECTOR_CONNECTION_REQUIRED`
      (exit 3 here, exit 1 for the owner's own missing connection): "To use
      your Gmail here, connect it in Ravi Console first:
      <console>/connectors", plus `reconnectLink`.
    - `connector_forbidden` in `shared` → `CONNECTOR_FORBIDDEN`: "I can't use
      a shared Gmail account in this conversation."
    - `connector_unavailable` (503) with reason
      `shared_connection_unavailable` in `shared` (the grant's organization
      account was disconnected or paused) → `CONNECTOR_CONNECTION_REQUIRED`,
      not retryable: "I can't use the shared Gmail account right now." Any
      other 503 stays the retryable `SERVER_UNAVAILABLE`.
    - `connector_group_blocked` → the person-asking group line, or for
      `shared` "I can't use the shared account in this group."
    - Approvals, denials, blocked tools, a disabled organization and
      permission answers keep invariant 4's shape with the holder changed:
      for `person_asking` the person asking, in this direct chat; for
      `shared` the account's manager, and the chat line carries no link.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | destructive (deletes stored provider tokens) | dry-run + `--execute` (`--yes` = documented equivalent) |
| connect | human-in-the-loop browser flow on the Console | not braked (declared interactive) |
| mode → `person-asking` or `shared` | expands whose account answers an agent's turns | dry-run + `--execute` |
| mode → `owner`, or no value | narrows to the default, or reads | immediate |

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
| braked mode change without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| a mode change (or read) from a turn that is not the operator's | `CONNECTOR_SPEAKER_NOT_OWNER` | 3 |
| unknown provider or mode for `connectors mode` | `USAGE_ERROR` | 2 |
| unknown agent for `connectors mode` | `AGENT_NOT_FOUND` | 1 |
| `--shared` without the agent in shared mode or outside a chat, `--connector` in an agent mode | `PAYLOAD_INVALID` | 2 |
| the agent's mode changed while the command ran | `CONFLICT` | 1 |
| person asking must consent first | `CONNECTOR_CONSENT_REQUIRED` + `consentLink` | 3 |
| person asking is not linked, or not a member | `CONNECTOR_NOT_LINKED` | 3 |
| person asking has no connection, or the shared account was disconnected or paused | `CONNECTOR_CONNECTION_REQUIRED` | 3 |
| person asking in a direct chat whose session other people share | `CONNECTOR_GROUP_BLOCKED` | 3 |
| no shared account for this agent and conversation | `CONNECTOR_FORBIDDEN` | 3 |
| no connection for the provider (the owner's own) | `CONNECTOR_CONNECTION_REQUIRED` | 1 |
| connection must be reconnected | `CONNECTOR_REAUTH_REQUIRED` | 1 |
| connection is read only, or misses a provider permission (Link `connector_permission_required`) | `CONNECTOR_PERMISSION_REQUIRED` | 1 |
| tool policy above the organization's limit (Link `connector_policy_above_ceiling`, Console only) | `CONNECTOR_POLICY_ABOVE_CEILING` | 1 |
| only the connection's owner may do that | `CONNECTOR_FORBIDDEN` | 1 |
| authorization expires before completion | `CONNECTOR_AUTH_EXPIRED` | 1 |
| authorization is rejected (for example opened by another user) | `CONNECTOR_AUTH_REJECTED` | 1 |
| terminal authorization state is invalid | `CONNECTOR_AUTH_STATE_INVALID` | 1 |
| no `ravi login` session (any turn), or a stored session that is not the classified user's | `AUTH_REQUIRED` | 1 |
| other remote/provider errors | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

`gmail` wraps `execCapabilityWithApproval`, `resolveConnectorExecPlan` and
`listConnectors` from `src/link/connectors.ts`; it consumes the helpers, not
the braked `revoke`. It asks the plan first: in `owner` mode it picks the
owner's connection (`--connector` or the default); in an agent mode it lists
nothing and sends no connection id. `gmail send` keeps its brake before the
plan.
`gmail list`, `gmail read` and `gmail send` all have gateway routes: every
agent turn carries `RAVI_CONTEXT_KEY` and so runs its commands through the
host gateway, and an agent must be able to reach `gmail send` to get the
approval answer and re-run with `--approval <id>`. `gmail send` keeps its
`--execute` brake there. A gateway turn is never the operator's terminal, so
an approval answer is returned (exit 3), and the relay keeps its message,
chat line and approval keys (invariant 5a).

The shipped `connectors` skill (`ravi skills show connectors`) teaches agents
who may use a connection, the agent modes and `ravi connectors mode`, the
`CONNECTOR_*` codes with what to say (consent, not linked and connection
required for the person asking), and the approval loop. The docs page
`console/connectors` explains the three modes in plain words. The Calendar tools (`gcal.event.list`, `gcal.freebusy.query`)
have no `ravi` command yet. The docs page `console/connectors` and the skill
name them and point to the connection's Tools in the Console; they do not
point to `connectors show`, whose `capabilities` list is whatever Link stores
for the row (empty for connections made with the current connect flow).

## Validation

- `bun test src/link/ src/runtime/turn-origin.test.ts src/runtime/turn-reply-target.test.ts src/cloud-auth/connector-auth.test.ts`
  green (classification rows, automation marker, lineage liveness, header
  encoding, connect via the Console, approvals, session pinning). A relay
  run through `buildRuntimeStartRequest` and its first turn, into a session
  that posts into a group and with `_cliDestination`, is in
  `src/link/connector-turn.relay.test.ts`. `bun run test` runs `src/link/`,
  `src/runtime/turn-origin.test.ts` and `src/runtime/turn-reply-target.test.ts`.
- Each of `src/cli/commands/connectors.test.ts`,
  `src/cli/commands/connectors-mode.test.ts`, `src/cli/commands/gmail.test.ts`,
  `src/cli/commands/mail.test.ts`, `src/cli/commands/settings.test.ts`,
  `src/cloud-auth/errors.test.ts` and `src/cli/remote-gateway.test.ts` green
  in its own `bun test <file>` run, as `bun run test:cli-commands` runs them
  (their `mock.module` calls collide when several share one process)
  (contract describes, `--project` warning, flags, error mapping,
  default connection, gateway relay, the terminal check of the approval
  wait, the mode command's brake and operator check, the settings guard).
  The routing table per mode and speaker and the agent exec header are in
  `src/link/connector-turn.test.ts`; the agent exec request and its answers
  against a fake Worker in `src/link/connectors.test.ts`. The approval flow itself runs against a fake Worker (the real
  `LinkApiClient` over a fake fetch) in `src/link/connectors.test.ts`.
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
- Before the fix, the operator relay classified as `terminal` whatever the
  session did with the answer: a relay has no chat compartment, so
  `ravi sessions send <group-session> "..."` read the owner's mail and the
  session posted it into the group (its output attachment). The turn now
  records where its answer goes (invariant 3a); a relay without that record
  (a turn context from a daemon older than the CLI) is blocked until the
  daemon restarts.
- Before the fix, the owner's own direct chat had no session check: with
  `dmScope: main`, a route that sends several chats to one session, or
  another person's chat attached, the owner's mail stayed in a transcript the
  others could ask about. Relays and routines answering into the owner's
  direct chat are still checked only by where the answer goes, not by who
  else writes in that session.
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
- Before the fix, `shared` mode sent the owner's own routines to agent exec
  with conversation `automation`, which no grant can list (grants hold only
  `dm`/`group`), so every cron or heartbeat Gmail call failed. They now keep
  the owner's connection; only `--shared` in a chat moves an owner's turn.
- `person_asking` checks the session's structure (key, routes by name,
  attached chats), not its history: a chat attached to the session later,
  by the operator, is checked only from then on. Queued messages folded into
  one turn take the last message's actor; in a per-person session they are
  all that person's, but a relay from the operator or another agent folded
  with them runs on the person's account.
- Before the fix, `person_asking` accepted any direct chat, so with
  `dmScope: main` (or a route that sends several chats to one session) one
  person's mail landed in a transcript the others could ask about.
- The Worker trusts the exec header (it cannot verify it): the CLI is what
  keeps `consoleUserId` out of agent exec and the mode behind the operator.
- Other cloud commands still use `getMeWithAutoRefresh` with the default
  delete, which promotes the next stored user after a failed refresh. A
  connector call after such a promotion treats the promoted user as the
  operator; pinning the operator at login is not done yet.

# Connectors agent-first CLI contract / CHECKS

## Checks

### Turn classification

- A connector call with no runtime context (terminal) MUST use the active
  `ravi login` session; with no session it MUST fail `AUTH_REQUIRED` (exit 1),
  and so MUST the owner's own linked direct chat.
- After a failed refresh, a connector call MUST drop the active pointer
  without promoting another stored user, and a Console `me.user.id` that
  differs from the classified user MUST fail `AUTH_REQUIRED`.
- A process with `RAVI_AUTOMATION_PRINCIPAL=automation:<cron|trigger|job>:<id>`
  and no context key MUST classify as that principal; a real shell cron, a
  shell trigger env and a `ravi jobs run` spawn MUST carry it, and an env file
  MUST NOT override it. `RAVI_TRIGGER_ID` alone MUST block.
- A runtime marker (`RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, `RAVI_AGENT_ID`)
  without a resolvable `RAVI_CONTEXT_KEY`, a revoked or expired context, and a
  tool/gateway transport without a live context MUST all exit 3
  `CONNECTOR_SPEAKER_NOT_OWNER` before any Console or Link call.
- `automation:operator:local` and `agent:bootstrap` MUST be allowed as speaker
  `owner`, conversation `terminal`, only with a `session-relay` origin of
  action `send` or `ask`, no session and the same principal; `execute` (the
  goal wake), `inform`, a relay from a session, or no origin MUST block.
- Such a relay MUST be allowed as `terminal` only when its turn context's
  `turnReplyTarget` is `none`, or `unresolved` while the session has no
  output attachment. A relay whose answer the session posts into a group or
  another person's chat (the recorded chat, or the output attachment of an
  `unresolved` target) MUST exit 3 `CONNECTOR_GROUP_BLOCKED` with
  `speakerIsOwner`; into the owner's linked direct chat it MUST be allowed
  with conversation `dm`. A relay with no readable `turnReplyTarget`, or an
  `unresolved` one without a session, MUST be blocked. Run through
  `buildRuntimeStartRequest`, a relay into a session whose output is a group
  MUST be blocked, and the same relay with `_cliDestination` MUST be allowed.
  Both relay blocks MUST carry, in the envelope, the `suggestedAction` to
  post nothing from the account into that chat (the owner can run the
  command in their terminal), never the catalog step to answer in the group;
  the owner's shared-session block MUST carry the one to reply with the chat
  line and not retry until each person has their own session. A relay
  blocked by where it answers MUST still change a mode (`connectors mode`)
  and own the crons it creates (`operator`).
- The runtime MUST record `turnReplyTarget` on the turn context at every
  turn start: `none` when the turn posts to no chat (`suppressChatEmit`),
  the bound chat when there is one, `unresolved` otherwise.
- A live `admin-bootstrap` root with `admin:system:*` and no actor MUST be
  allowed as the terminal; the same kind without the capability, or a child
  of a revoked one, MUST block.
- A resolved contact whose `consoleUserId` is the active session's user, in a
  `dm:` compartment whose session is the owner's own (the `person_asking`
  session check), MUST be allowed as speaker `owner`, conversation `dm`.
  The same contact with a different `consoleOrgId` MUST be blocked. In a
  session other people's chats share (`dmScope: main`, a group key, an
  unknown session, a route by session name, another person's chat attached)
  it MUST exit 3 `CONNECTOR_GROUP_BLOCKED` with the chat line telling the
  owner to give each person their own session (`replyTo: same_chat`), in
  every agent mode; only `--shared` in `shared` mode moves it to the shared
  account. That turn MUST still change a mode (`connectors mode`) and own
  the crons it creates (`operator`).
- A contact linked to another Console user MUST be blocked
  (`CONNECTOR_SPEAKER_NOT_OWNER`, exit 3) and MUST NOT switch to that user's
  stored session, even when one exists.
- An unlinked contact, `missing_contact`, and `unknown` MUST be blocked, and
  the unlinked case MUST mention `ravi link`.
- `agent:<id>`, `automation:session:*`, `automation:trigger:*`,
  `automation:observer:*`, `session-followup` and `daemon-restart` MUST be
  blocked.
- `automation:heartbeat` MUST be allowed with routine `heartbeat`.
- `automation:cron:<jobId>` MUST be allowed only for a job whose
  `owner_principal` is NULL, `operator`, or a contact linked to the active
  user and org; a job owned by anyone else, or a missing job, MUST be blocked.
- A cron or heartbeat that answers into a chat MUST be allowed only when that
  chat is a `dm` resolving to the owner's linked contact; a group, another
  person's DM, an unlinked contact, another org or an unknown chat MUST exit 3
  `CONNECTOR_GROUP_BLOCKED`.
- A revoked or expired context anywhere on the walk, or a projected actor
  whose source context is not live, MUST block.
- Any contact turn in a `chat:` compartment MUST exit 3 `CONNECTOR_GROUP_BLOCKED`: the
  owner gets "I'll send this to you privately.", anyone else "I can't use
  <owner>'s Gmail for your request." (with the Portuguese line in
  `chatLinePt`).
- A derived child context MUST classify by its nearest ancestor that carries
  `actorPrincipal`; a chain with no actor MUST be blocked. A projected actor
  MUST take its compartment from its source context.
- The public envelope of a locally classified block MUST carry the chat line
  (`details.chatLine`, `chatLinePt`, `replyTo`); a Link or Console error with
  the same code MUST keep the fixed catalog copy and no chat line.
- Over the host gateway, `gmail *` and `connectors *` blocks with a chat line
  MUST keep the local message, `chatLine`, `chatLinePt`, `replyTo` and a
  Console `/connectors` `reconnectLink`; any other reconnect link or reply
  target MUST be dropped, and other commands MUST NOT carry chat lines.
- Over the host gateway, a `CONNECTOR_APPROVAL_REQUIRED` or `_PENDING`
  answer MUST keep `approvalId`, `approvalLink`, `retryWith` and
  `expiresAt`; an approval link that is not the Console page of that id, a
  `retryWith` other than `--approval <id>`, an unparseable `expiresAt` or a
  malformed id MUST be dropped.
- `gmail send` MUST have a gateway route (`/api/v1/gmail/send`): an agent
  turn sent through a real host gateway with `--execute` MUST come back exit
  3 `CONNECTOR_APPROVAL_REQUIRED` with the approval keys above, never a 404.

### Calls

- `execCapability` MUST send `X-Ravi-Exec-Context` whose base64url JSON
  decodes to `{ v: 1, speaker, conversation, ... }` from the classification,
  with `turnKey` = sha256 hex of the root turn context id, and MUST keep the
  header at or under 2048 bytes.
- A Link `connector_reauth_required` answer on exec MUST become
  `CONNECTOR_REAUTH_REQUIRED` with the private reconnect line,
  `replyTo: owner_privately` and the whole `reconnectLink`; the envelope MUST
  contain no `[REDACTED` marker and human output MUST print the chat line.
- A Link approval answer MUST keep only `approvalId`, `expiresAt` and
  `reason`, and exec MUST turn it into an exit-3 error with `approvalLink`
  (`<console>/connectors/approvals/<id>` from the active login, never the
  Worker's `approvalUrl`), `expiresAt`, `retryWith: "--approval <id>"` and
  the private chat line; the message MUST say "never in a group" and name
  `--approval <id>`.
- `gmail send|list|read --approval <id>` MUST send `X-Ravi-Approval`; a
  malformed id MUST fail `PAYLOAD_INVALID` before any call.
- Against a fake Worker: at the operator's terminal a 409 approval answer
  MUST open the Console page, poll `GET /cli/approvals/:id` with 2 s between
  polls and, once `approved`, send the same body once more with the header; a
  re-run whose approval is still pending MUST wait the same way. `denied`
  while waiting MUST exit 3 `CONNECTOR_APPROVAL_DENIED` with no second exec;
  `expired`, `consumed` or a 404 MUST exit 1 `CONNECTOR_APPROVAL_INVALID`
  with no second exec; a 503 while waiting MUST keep waiting; a 401 while
  waiting MUST re-authenticate once and keep polling, and a second 401 in a
  row MUST fail `AUTH_EXPIRED` after exactly two polls with no sleep between
  them; 10 minutes without a decision MUST return the approval answer
  (exit 3).
- Against a fake Worker, an approved action that then asks for a step-up
  MUST send the step-up retry with both `X-Ravi-Approval` and the step-up
  token, and MUST NOT ask for a second approval. In a runtime turn the
  step-up MUST exit 3 `INTERACTIVE_ONLY` without opening a browser or
  reading stdin.
- Outside the operator's terminal (stdin or stdout not a TTY, a runtime
  context, or `--json`) the approval answer MUST exit 3 without polling.
- Link `connector_approval_denied` MUST exit 3 with the "Okay, I didn't do
  it" line; `connector_approval_invalid` MUST exit 1 and say to run again
  without `--approval`; `connector_tool_blocked` and
  `connector_disabled_by_org` MUST exit 3 with a line for the owner, sent
  privately; `connector_permission_required` with `accessMode: read_only`
  MUST exit 1 `CONNECTOR_PERMISSION_REQUIRED` and point to Allow writing.
- Every Worker code of the connectors contract (`connector_group_blocked`,
  `_speaker_not_owner`, `_disabled_by_org`, `_tool_blocked`,
  `_approval_required|pending|denied|invalid`, `_consent_required`,
  `_not_linked`, `_connection_required`, `_policy_above_ceiling`,
  `_forbidden`) MUST map to its uppercase CLI code with the exit of the
  official error table.
- `connectors connect` MUST call `POST /api/cli/connectors/connect/start` on
  the Console with the bearer and MUST NOT call Link to start. The body MUST
  omit unset keys; `--read-only` → `accessMode: "read_only"`,
  `--reconnect <id>` → `reconnectConnectionId`, `--name` → `displayName`.
- An incomplete start answer MUST fail `SERVER_UNAVAILABLE`.
- `connectors connect --project x` and `connectors list --project x` MUST
  print exactly
  `--project is ignored: connections belong to you, not to a project (removed after 2027-01-01)`
  on stderr and MUST NOT send the project anywhere.
- `connectors list` human output MUST show each connection's account email.
- `gmail` without `--connector` MUST pick the `isDefault` row only while it
  is `active`, else the newest active Google row without `requiresReauth`,
  and MUST skip history rows. With no Google row it MUST fail
  `CONNECTOR_CONNECTION_REQUIRED` (exit 1); with only rows that need
  reconnecting, `CONNECTOR_REAUTH_REQUIRED` (exit 1).

### Cron owner

- `cron add` from the terminal MUST store `owner_principal = operator`;
  `cron show` MUST report a legacy NULL as `operator` ("Runs as" and
  `ownerPrincipal`).
- Opening a database whose `cron_jobs` lacks `owner_principal` MUST add the
  column and keep existing rows NULL.
- `cron set <id> <key> ...` from a turn that is not the operator MUST make
  that turn's principal the job's owner, in the same write, for every key but
  `name`, `description`, `cron`, `every`, `tz`, `timezone`, `timeout` and
  `delete-after`.
- `cron add` with an idempotency key MUST deduplicate across owners: the
  owner is not part of the fingerprint.

### Agent-first contract

- `connectors revoke <id>` without `--yes` and without `--execute` MUST exit 3
  with `dryRun: true` and the plan `{id, deletesStoredCredentials: true}`, and
  MUST NOT call the Link revoke endpoint.
- `connectors revoke <id> --execute` MUST revoke, and the legacy
  `connectors revoke <id> --yes` MUST keep revoking (documented equivalent —
  the flag is not renamed and not removed).
- `connectors connect` is declared unbraked (human-in-the-loop browser flow)
  and MUST NOT gain an `--execute` requirement.
- `connectors connect --no-open --json` MUST return one parseable `started`
  document immediately. A waiting JSON flow MUST emit exactly one terminal
  success or one canonical `CONNECTOR_AUTH_*` failure with exit 1.
- `connectors list --fields a,b,c --json` MUST return connection items
  containing only the requested fields.
- A `ContractError` thrown inside a connectors command MUST pass through
  `runConnectorCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST keep their stable CloudAuthError codes while using the
  global exit map (`PAYLOAD_INVALID` → `2`; connector policy codes → `3`;
  other provider/auth failures → `1`).
- `bun test src/link/ src/runtime/turn-origin.test.ts src/cloud-auth/connector-auth.test.ts`
  and, each in its own `bun test <file>` run (their `mock.module` calls
  collide in one process), `src/cli/commands/connectors.test.ts`,
  `src/cli/commands/connectors-mode.test.ts`, `src/cli/commands/gmail.test.ts`,
  `src/cli/commands/settings.test.ts` and `src/cli/remote-gateway.test.ts`
  SHOULD pass after any change to this contract surface; `bun run test` runs
  `src/link/`.

### Per-agent mode

- `ravi connectors mode main google` MUST show `owner` ("Only when I ask")
  when no row exists, and MUST NOT write.
- `ravi connectors mode main google person-asking` and `... shared` without
  `--execute` MUST exit 3 `WRITE_REQUIRES_EXECUTE` with the plan `{agentId,
  provider, from, to, affects}` and MUST NOT write the setting; with
  `--execute` they MUST store `person_asking` / `shared`.
- `ravi connectors mode main google owner` MUST apply without `--execute` and
  remove the row.
- From a contact's turn, every `connectors mode` call (read, owner, or an
  expansion with `--execute`) MUST exit 3 `CONNECTOR_SPEAKER_NOT_OWNER` with
  "Only <owner> can change that." and MUST NOT change the row. The owner
  asking in a group MUST exit 3 `CONNECTOR_GROUP_BLOCKED` with "Ask me in our
  private chat and I'll change it." and MUST NOT change the row. The owner's
  own direct chat (also in a shared session), the operator's
  `ravi sessions send|ask` wherever the session posts its answer, and the
  terminal MUST pass.
- An unknown provider or mode MUST exit 2 with `acceptedPositionals`; an
  unknown agent MUST exit 1 `AGENT_NOT_FOUND` with suggestions, both before
  the brake.
- `ravi settings set connectors.mode.<agent>.<provider> ...` and `ravi
  settings delete connectors.mode.<agent>.<provider>` (with or without
  `--execute`) MUST fail and MUST NOT write.
- Deleting an agent and creating it again with the same id MUST read
  `owner`; another agent whose id starts the same way (`a.b` for `a`) MUST
  keep its mode.
- A stored value other than `owner`, `person_asking` or `shared`, or an
  unreadable store, MUST read as `owner`.
- Routing MUST follow invariant 23's table in every cell: in
  `person_asking`, a resolved contact (linked to another user or not linked)
  in a direct chat with a session of their own goes to agent exec, in a
  group exits 3 `CONNECTOR_GROUP_BLOCKED` with "I can only use your Gmail in
  a direct chat with me. Ask me there.", and in a direct chat whose session
  other people share exits 3 `CONNECTOR_GROUP_BLOCKED` with "I can't use
  your Gmail in this conversation." before any call; in `shared`, contacts
  in direct chats and groups and routines answering into someone else's
  chat go to agent exec `shared` with their real conversation; every turn
  the owner table allows (the terminal, the operator relay, the owner's
  direct chat, the owner's cron jobs and heartbeats) stays on `/cli/exec/:id`
  in every mode unless `--shared` in a chat; agent relays, triggers,
  unresolved senders and ended turns stay blocked in every mode.
- A direct chat MUST NOT count as the person's own session when the session
  key is `agent:<id>:main` or not a direct-chat key, when the turn's
  contexts name different sessions or none, when an active route names the
  session, or when a chat of another contact is attached to it.
- `--shared` on an agent not in `shared` mode, at the terminal, on the
  operator relay or on a routine posting nowhere MUST be `PAYLOAD_INVALID`
  and MUST NOT unblock a contact; `--connector` in an agent mode MUST be
  `PAYLOAD_INVALID`; a mode that changed between the plan and the exec MUST
  fail `CONFLICT` before any call.
- `POST /cli/agent-exec` MUST carry `{provider, capability, parameters,
  mode}` and an exec context with `agentId` and, for a contact, only
  `speaker.contactId`: never `consoleUserId`. `agentId` MUST survive the 2 KB
  limit or the call fails `PAYLOAD_INVALID`.
- `connector_consent_required` MUST exit 3 `CONNECTOR_CONSENT_REQUIRED` with
  `consentLink = <console>/connectors/consent/<token>` from the active
  login's Console (never the Worker's host), the chat lines "To use your
  Gmail here, approve it once: <link>" / "Para eu usar o seu Gmail aqui,
  aprove uma vez: <link>", `replyTo: same_chat`, and a message that does not
  quote the token. A consent URL without a valid token MUST yield no link and
  no chat line.
- `connector_not_linked` MUST exit 3 `CONNECTOR_NOT_LINKED` with a chat line
  that names no command and a message that tells the agent to run `ravi
  link` in their turn; `connector_connection_required` MUST exit 3 for the
  person asking (with the Console connectors link) and stay exit 1 for the
  owner's own connection.
- `connector_forbidden` in `shared` MUST exit 3 with "I can't use a shared
  Gmail account in this conversation."; an approval for a shared account MUST
  carry a chat line without a link.
- A 503 `connector_unavailable` with reason `shared_connection_unavailable`
  in `shared` MUST exit 3 `CONNECTOR_CONNECTION_REQUIRED`, not retryable,
  with "I can't use the shared Gmail account right now."; any other 503 MUST
  stay the retryable `SERVER_UNAVAILABLE`.
- The gateway relay MUST keep `consentLink` (only a Console
  `/connectors/consent/<token>` page) and `expiresAt` of a consent answer,
  and the chat lines of the not-linked and connection-required answers with
  exit 3.

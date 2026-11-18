---
id: cli/bases
title: "Bases agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - bases
tags:
  - cli
  - cloud
  - bases
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - idempotency
applies_to:
  - src/cli/commands/bases.ts
  - src/bases/client.ts
  - src/bases/schemas.ts
  - src/bases/input.ts
  - src/bases/csv.ts
  - src/bases/format.ts
  - src/bases/import.ts
  - src/cloud-auth/client.ts
  - src/cloud-auth/errors.ts
  - src/cli/cloud-error-contract.ts
  - src/cli/skill-gates.ts
  - src/plugins/internal/ravi-system/skills/bases/SKILL.md
  - src/plugins/internal/ravi-system/skills/bases/references/pages.md
  - src/plugins/internal/ravi-system/skills/pages/references/data-pages.md
  - src/plugins/internal/ravi-system/skills/solucoes/SKILL.md
  - src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md
  - src/plugins/internal/ravi-system/skills/bases/references/events-triggers.md
  - src/inbox/bases-enrichment.ts
  - src/permissions/runtime-bootstrap-provider.ts
  - src/triggers/topic-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Bases agent-first CLI contract

## Intent

`ravi bases` is the local CLI over the Ravi Console Bases API
(`/api/cli/projects/<project>/bases/...`): typed, project-scoped databases with
properties, rows, views, charts, and row-event subscriptions. The OSS side is
transport and plumbing. It sends requests, renders responses, and maps errors.
The Console owns authorization, view policy, filter compilation, validation,
and aggregation.

Bases is backend only. There is no Console UI for Bases. Agents create bases,
properties, views, and charts through this CLI. Every screen over a base
(table, board, form, dashboard, chart, portal) is a Ravi Page the agent
generates and ships with `ravi pages ship --uses <ids>`; the page reads and
writes only through a view, via the `ravi.bases.*` Pages connector actions
(see "Generated Pages"). The `bases` skill documents that workflow.

## Invariants

1. The CLI MUST NOT evaluate view access rules, Query AST filters, or
   authorization. Filters, view specs, chart specs, and access blocks are
   opaque JSON forwarded to the Console. Local parsing is structural only
   (JSON shape, flag syntax, documented limits).
2. Every command MUST accept `--json`. With `--json`, success prints the
   command payload and failure prints the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
3. Exit codes MUST follow the taxonomy: `0` success, `1` error, `2` usage
   (`PAYLOAD_INVALID`), `3` write brake (`WRITE_REQUIRES_EXECUTE`).
4. Project scope MUST resolve through the Console scope resolver:
   `--project` wins, then the saved Console scope. `--console` MUST match the
   stored credentials, otherwise the command fails with `AUTH_REQUIRED`.
5. Row writes (`rows add`, `rows update`, batch import, `rows
   request-approval|approve|reject`, `rows fill`) and the creates `bases
   create`, `props add`, `views create` and `charts create` MUST send an
   idempotency key both as the `Idempotency-Key` header and as
   `idempotencyKey` in the body. The key is generated per call unless
   `--idempotency-key` overrides it. Keys MUST match
   `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`. The same key and request replay the
   created object; a different request with the key is `CONFLICT`
   (`idempotency_conflict`). Creates carry no `clientHint`. A keyed request
   MUST NOT include a value the CLI read just before (the Console hashes the
   whole request): `props add --idempotency-key` requires
   `--expected-schema-version` (exit 2 before any call), and approval writes
   follow invariant 21.
   Inside an agent session, `rows add` and `rows update` without
   `--idempotency-key` still write, and MUST add `warnings: [string]` to the
   payload (a `warning:` line in human output): a retry would get a new
   generated key and could duplicate the write.
6. Inside an agent session (runtime tool or gateway invocation), row writes
   row archive/restore, `rows fill` and `rows rerun` MUST carry
   `clientHint {agentId?, sessionKey?, sdk}`. The hint is ledger metadata the
   Console records next to the accountable person (`agent` on history
   entries, asserted by the installation) and MUST NOT be sent outside an
   agent session.
6a. Every Console call, reads included, MUST carry the turn's actor
   (`x-ravi-actor-contact`) inside a runtime turn, so a linked person's reads
   and writes act as that person. The Console refuses an unlinked person's
   reads and writes with `ACTOR_NOT_LINKED` (403, which starts the link
   flow); the CLI never retries them as the operator. Inside a runtime turn
   that `resolveAccessActor` refuses (another agent's turn, an unresolved
   speaker) or cannot classify, `openBasesClient` MUST fail `ACTOR_UNKNOWN`
   (exit 3, policy) before any Console call, reads included, instead of
   sending no actor (which the Console would serve as the operator). A run
   of a cron job a contact owns (`owner_principal = contact:<id>` not bound
   to the operator) MUST carry that contact as the actor: the job acts as
   that person (its creator, or whoever last changed what it runs)
   through their own `ravi link` (and fails
   `ACTOR_NOT_LINKED` without one), never as the operator who ran
   `ravi login`. A cron job no person owns (`unknown`, an agent) is refused.
   A shell cron the daemon spawned
   (`RAVI_AUTOMATION_PRINCIPAL=automation:cron:<id>`; an operator-owned run
   also carries its short-lived `cron-shell` context key, connectors 13c)
   counts as a runtime turn here; shell triggers and `ravi jobs run` are not
   covered (6b covers the agent turns a trigger fires). That marker is not a
   boundary: a shell command
   controls its own environment and runs with the machine's access, so only
   a job that acts as the operator may be a shell job (connectors 13b). Operator turns,
   owner relays and owner-owned routines act as the operator. Outside a turn
   no actor header is sent.
   When a cron run's contact is not linked, the link flow MUST NOT message
   anyone (nobody is asking in a scheduled run): the refusal carries
   `linkFlow: routine`, no `chatLinePt`, and a suggested action to report
   to the operator, without retrying or disabling the job, that the job's
   creator must link their account.
   The refusal MUST carry a typed reason in `error.refusalReason`:
   `routine_not_operator_owned` (a cron job or a trigger no person Ravi can
   act for owns; with `routine` (`cron` or `trigger`), `jobId` (the job's or
   the trigger's id) and `ownerPrincipal`), `routine_shared_session` (an
   owned trigger fired into a session that is not its own) and
   `routine_answers_elsewhere` (an owned trigger whose turn answers into a
   chat that is not its owner's), both with `routine` and `jobId` (see 6b),
   `agent_relay`, `ended` or `unknown`, and a
   `suggestedAction` true for that reason. A routine run has nobody to ask,
   so its action MUST NOT tell the agent to have the person ask from their
   chat: it says not to retry from the run, to report the job to the
   operator without disabling it, and that the operator reviews the job's
   message or command and recreates it from the turn of the person it
   should act for. This copy is
   local: it applies only to the error `openBasesClient` (and the access and
   cloud-run clients) build, marked by its class, never to an
   `ACTOR_UNKNOWN` a Console response carries, which keeps the catalog copy
   whatever its `details` say.
   A verified human work handoff follows the attribution contract in
   `contacts/identity-graph/message-session-attribution`: it MUST pass the
   human requester to Bases/access while retaining the agent producer for
   audit. Work delegated from a verified request (a Slack thread's later
   handoffs from its own parent session, a task's dispatch turns) MUST act for
   that requester under "Delegated Work Keeps Its Requester" in the same spec.
   An agent-only relay remains refused. Remote transport MUST preserve
   the bounded public `ACTOR_UNKNOWN` message, suggested action, typed refusal
   reason and request correlation, never replace them with generic
   "Remote command was blocked by policy." Raw Console errors still pass
   through the local catalog mapper before remote projection.
6b. An agent turn a trigger fired (`automation:trigger:<id>`) MUST act in
   Bases as the trigger's owner, and only in Bases.
   - **Owner.** `triggers.owner_principal` is written once, when the trigger
     is created, with the principal of the creating turn under the cron rule
     (connectors 13a): `operator` for the terminal and the owner's own turns,
     else the actor principal of the turn. `triggers add`, `bases subscribe
     --trigger` (read before any Console call) and `watch trigger` MUST
     record it. An unattributable turn (`unknown`) owns nothing.
   - **Losing it.** No update can give a trigger an owner. Any update that is
     not owner-neutral MUST clear the owner in the same statement, unless the
     principal making it is the stored owner (`keepOwnerFor`, compared in the
     statement itself). Owner-neutral is only: `cooldown`, a shell `timeout`,
     and disabling. So `triggers set` of any other key keeps the owner only
     in the owner's own turn, and every programmatic writer (the generated
     follows that rebind or rewrite a trigger) clears it. `triggers enable`
     keeps the owner when the owner or the operator turns the trigger on: the
     operator arms a trigger someone else drafted, which still acts as that
     person and never as the operator; turned on by anyone else, it has no
     owner. Nobody takes a trigger over by editing it, the operator included:
     its name, topic, filter, agent, session and reply target all shape a
     turn that carries other people's text. To own a trigger, create it.
   - **No owner.** A trigger with no owner acts as nobody: every trigger
     written before owners were recorded, every generated follow (`gh` PR
     follows, bug follows, Pages comment follows), and any trigger someone
     other than its owner changed. There is no backfill and, unlike a cron
     job, no owner never means the operator.
   - **Snapshot.** The runner MUST decide the owner when the trigger fires
     and carry it with the prompt (`_triggerAuthority`: `triggerId`,
     `ownerPrincipal`, `ownerIsOperator`, `ownSessionKey`). It MUST read the
     stored row, and admit its owner only when that row is still the
     definition it subscribed (name, topic, message and its provenance,
     filter, agent, account, session, reply session and source, execution
     type, debounce, enabled); a row that changed and was not reloaded yet,
     or is gone, fires with no owner. A test fire (`triggers test`) MUST be
     admitted only when the principal that asked for it is the owner. The
     classification MUST read the snapshot only from the host-issued turn
     context (a child context inherits it and cannot supply one), MUST treat
     a missing or malformed snapshot, or one for another trigger, as no
     owner, and MUST apply the cron ceiling: the turn acts as the operator
     only when the snapshot said so and the owner still does.
   - **A session of its own.** The owner's authority is lent only in the
     trigger's own session: the one session of an `isolated` trigger a
     person owns. Every other session is one anyone can name (the agent's
     main session, a chat's session, a named or templated one, the one it
     creates included): it inherits whatever was keyed to that name before
     (history, contexts, signals) and takes other triggers' fires, so it
     never lends. The turn still runs there as before, with nobody's
     authority.
     - **Key.** A trigger's runner writes three keys: `agent:<agent>:trigger:<id>`
       (the plain one-per-trigger session of an `isolated` trigger nobody
       owns, as before owners existed), `agent:<agent>:trigger:<id>:own`
       (the own session of an `isolated` trigger a person owns) and
       `agent:<agent>:trigger:<id>:key:<24 hex>` (a named session the
       trigger created). The session store MUST create a session under any
       of them for the trigger runner only and refuse every other creation
       (`SESSION_KEY_RESERVED`), so a session created from a name someone
       chose never has one. Session keys are never rewritten, and a key
       derived from one of them (a thread) is not one of them.
     - **Which session.** For an `isolated` trigger the runner MUST read the
       stored trigger when it fires: a person owner (`operator` or
       `contact:<id>`) runs in the own session, anything else in the plain
       one. A trigger that loses its owner therefore moves to the plain
       session, and the own session, which holds what its owner's turns
       read, is never entered again. The own session MUST be found by its
       key alone and MUST go by that key as its only name, which the session
       store gives to no other session, before the own session exists or
       after it is deleted: nothing keyed to its name was another session's,
       and nobody inherits what it stored. A character a session name
       cannot hold (a dot, whitespace, `*`, `>`, which only an unusual agent
       id brings) is written in the name as `~<code>~`, and so is `~`
       itself, so the name stays one subject token and different keys keep
       different names. The
       session MUST start after whatever the journal held under that name
       before its first turn: the runner marks it when it creates the row,
       and on a later fire when the row has no mark.
     - **Nothing else runs there.** A trigger's own session runs that
       trigger's fires and nothing else.
       - A fire that reaches a session through a name, a key, a value from
         the event or a reply session MUST NOT run in an own session,
         whoever owns the firing trigger, the same owner included: a named
         or templated fire is skipped and logged, and a `main` trigger whose
         reply session is an own session runs in the agent's main session.
         A `main` cron job whose reply session is one does the same.
       - Every prompt a producer publishes passes the dispatcher's intake.
         For an own session the intake MUST admit only prompts that are its
         trigger's fires (`_trigger` with that trigger's id, and not the
         notice a failed shell command sends about itself) and the runtime's
         restart notice that names that very session, and MUST drop every
         other one as a terminal intake failure (`dispatch.intake_failed`,
         reason `trigger_own_session`; a decision delivery is rejected): a
         relay (`sessions send|ask|execute|inform`), a task report, a cron
         run, a hook action, a chat message. The intake judges the stored
         session, a runtime still living under the name and the name itself.
       - A shell trigger's `--on-error notify-session:<session>` MUST be
         refused when the session is an own session, and the runner MUST
         send no notice into one.
       - Hooks MUST NOT run for events of an own session, whatever their
         scope, and `append_history` MUST NOT write to its journal, also
         when the stored session is gone and only its name is left.
       - A chat id MUST NOT resolve to an own session: a reference by chat
         id reaches the chat's own session, or nothing.
       - The audit event of a command run in an own session
         (`ravi._cli.cli.*`) MUST NOT fire a trigger. A turn's command is
         dispatched through the gateway, which builds the event outside the
         command's context, so the gateway MUST mark it there
         (`_turnProvenance.origin: trigger`); an event built inside the
         command's context names the session in its invocation record.
       - `triggers add`, `triggers set session` and `bases subscribe
         --trigger` MUST refuse a literal `--session` that is another
         trigger's own session, also before that session exists (the name
         alone says whose it will be), and the runner MUST skip a fire whose
         session resolves to such a name; `sessions send` and the commands that
         publish like it MUST refuse an own session as a target; a trigger
         or a cron job created during a turn in an own session MUST NOT
         default its session or reply session to it.
       - A session name spelled like a trigger's session key MUST be only
         that session's own key, when a session is created, named or
         renamed, so no session goes by the key an own session has or will
         have. An own session MUST NOT be given another name. A route that
         forces such a name on another session MUST NOT fail the inbound
         message: the session keeps the name it would have without it.
       - A trigger MUST NOT fire on an event of the bus's own transport,
         whatever pattern delivered it: `ravi.session.*` (what a session
         streams), `ravi._reply.*` and `ravi.worker.*`. A wildcard pattern
         such as `ravi.>` is not a blocked topic, so the check is made per
         event.
     - **This turn.** The runner MUST put the own session's key in the
       snapshot (`ownSessionKey`) when the fire runs there, and `null`
       otherwise. The classification MUST lend the owner only when the
       turn's session key equals `ownSessionKey` and is the own key of the
       turn's own trigger. A fire's envelope that reaches any other session
       lends nothing.
     - **No conversation.** No route sends chats into the session by name
       and no chat is attached to it, the owner's own included: the session
       is not a place to chat. A chat attached or routed to it stops it from
       lending from that moment, mid-turn included, and its messages are
       refused at intake.
     - Anywhere else an owned trigger MUST fail `ACTOR_UNKNOWN` with
       `routine_shared_session`, `routine: trigger` and the trigger id in
       `jobId`, with an action that tells the agent to report it and that
       the owner gives the trigger its own session (`triggers set <id>
       session isolated`).
   - **One fire, one turn.** A prompt whose snapshot lends authority (the
     owner is the operator or a contact, and `ownSessionKey` is set) is an
     isolated turn envelope: it MUST NOT be folded with any other prompt in
     the pending queue or the debounce batch, MUST NOT receive held `!!`
     text or a deferred session bootstrap, and a running turn fired with one
     MUST NOT be steered. A turn made of more than one prompt MUST carry no
     snapshot. The turn that resumes after a context recovery restates the
     session's history, so it MUST carry no snapshot either; the
     continuation after an inactivity watchdog, whose text is the runtime's
     own notice, keeps it. Prompts whose snapshot lends nothing are
     delivered, folded and steered as before.
   - **Acting.** An operator-owned trigger sends no actor. A contact-owned one
     MUST send that contact on the project lookup and on every Bases call,
     and fails `ACTOR_NOT_LINKED` without their `ravi link`, with `linkFlow:
     routine` and nobody messaged. `openBasesClient` MUST classify the turn
     once and use that one decision to admit the call and to name its actor.
   - **Where it answers.** A turn acts for its owner only when its answer is
     posted to no chat.
     - The reply target the runtime recorded when the turn started
       (`turnReplyTarget`) is the whole answer. `none` stays with the owner;
       a chat, `unresolved` or no recorded target MUST fail `ACTOR_UNKNOWN`
       with `routine_answers_elsewhere`, `routine: trigger` and the trigger
       id in `jobId`. The chat a prompt names as its source is not counted:
       the answer goes there only when that chat is attached to the session,
       and then it is the recorded target.
     - A turn that lends its owner's authority is bound to that target from
       its start. When no chat is bound then, the runtime MUST post the
       turn's answer to no chat (`suppressChatEmit`) and record `none`: it
       MUST NOT look for a chat when the answer is sent, so a chat attached
       to the session during the turn never receives what the turn read.
     - What Bases returns is never posted to a chat by the turn's answer.
   - **Refusals.** A trigger no person owns MUST fail `ACTOR_UNKNOWN` with
     `routine_not_operator_owned`, `routine: trigger`, the trigger id in
     `jobId` and its `ownerPrincipal`, before any Console call, with an
     action that tells the agent to report it, not to disable it, and that
     the trigger is created again from the turn of the person it should act
     for. A turn with no valid snapshot, or whose contact owner is removed or
     blocked, MUST fail `ACTOR_UNKNOWN` `unknown`.
   - **Only Bases.** `openBasesClient` asks for trigger owners
     (`triggerRoutines`) for the refusal, the actor header and the link flow
     alike. Every other caller MUST keep refusing a trigger turn whoever owns
     the trigger, and MUST NOT name its owner: personal connectors
     (`CONNECTOR_SPEAKER_NOT_OWNER`, unchanged), Knowledge, Pages access
     (`share`, invites, access requests) and cloud runs.
   - **Not covered.** No owner is enforced on a shell trigger (its command
     runs with the machine's access; `triggers show` says so), and the turn
     that reports a shell trigger's failure carries no snapshot.
   - **Exposure.** A trigger's prompt carries event content other people
     wrote, so its owner lends their Bases authority to an agent reading it.
     The agent's own Bases grants (views and charts unless more is granted)
     and the Console role check stay the limit; the event text is data,
     never an instruction. The trigger's own session holds what its turns
     read, across fires. Nothing runs in it but its trigger's fires, and no
     hook observes it; reading it (`sessions read`) takes session access, as
     for any session.
   `triggers show|list|add|set|enable` JSON MUST carry `ownerPrincipal`
   (`unknown` with no owner), `runsAsOperator` and `ownsSession` (whether
   the trigger is set to run in its own session, `--session isolated`), and
   `bases subscribe --trigger` the same three fields in `trigger`. `add`
   MUST warn when an agent trigger's turns do not act as the operator;
   `set` and `enable` MUST warn when they took the owner away; text `show`
   and `add` MUST say, for an agent trigger a person owns, when its session
   is not its own, and `bases subscribe --trigger` MUST say so too. `bases
   subscribe --trigger` without `--session` keeps its default (the current
   session, or the agent's main one), which is not the trigger's own: such
   a trigger sees the event and answers there, and cannot read or write the
   base.
7. `rows update`, `rows archive`, and `rows restore` MUST require exactly one
   of `--expected-version <n>` or `--last-write-wins`, checked before any
   Console call.
8. Base, view, and chart mutations and property mutations MAY omit the
   expected version; the CLI then reads the current version first and sends
   it. The Console still rejects a concurrent change.
9. Errors MUST keep stable codes. Bases adds `NOT_FOUND`, `CONFLICT`, and
   `VERSION_CONFLICT`. A Console HTTP 409 MUST map to `AUTH_PENDING` only on
   `/api/cli/auth` paths (and the OAuth device flow); elsewhere a bare 409 is
   `CONFLICT` and a coded 409 keeps its code. Link aliases
   (`CONFLICT` to `ACTOR_BINDING_CONFLICT`) apply only to `/api/cli/link`.
10. Console `error.details` MUST surface in the CLI envelope:
    `details.error` as `consoleError`, `details.current` as `current` (the row
    at its current version on `VERSION_CONFLICT`), `details.fieldErrors` as
    `issues` with path `["values", <key>]`, plus `requestId` when present.
11. `PROJECT_ACCESS_DENIED` and `ORG_ACCESS_DENIED` MUST list the Bases scopes
    the stored login lacks (`missingScopes`) and suggest `ravi login` again
    when `console.bases.read` or `console.bases.write` is missing.
12. `rows query --all` and `views query --all` MUST follow cursors without
    changing the request between pages and MUST stop after the page that
    reaches `--max-rows` (default 10000). The payload reports `truncated` and
    a `nextCommand` that continues from the last cursor.
13. `rows import` MUST read the base schema, map CSV columns to property keys
    (`--map "Column=key"`, `"Column=-"` skips), fail with `PAYLOAD_INVALID`
    on cells that do not fit their type BEFORE the brake, and dry-run unless
    `--execute`. Batches (at most 500 rows) are sent in order; batch `i` uses
    the key `ravi-import:<sha256(file, project, base, mapping)>:<i>`, so the
    same command replays finished batches instead of duplicating rows.
14. CSV output (`--format csv`, `rows export`) MUST neutralize spreadsheet
    formulas in free-text cells with a leading `'`; import strips it again.
15. `bases subscribe` creates a Console subscription for this installation,
    with the optional filter `--view`, `--props` (1-20) and `--events` (from
    `row.created|updated|archived|restored`, `approval.requested|decided`,
    `agent.requested|backfill`), checked locally before any call and sent as
    `{viewId?, properties?, events?}`. Events then arrive through the existing
    inbox bridge on `ravi.console.inbox.item` with `category: "bases"`. The OSS
    runner MUST NOT add a NATS subject for Bases; it MAY only add
    `payload.row` and `payload.rowEnrichment` (read with the installation
    credential) to `bases.row.*`, `bases.approval.*` and
    `bases.agent.requested` items, never to `bases.rows.bulk_changed` or
    `bases.agent.backfill`.
15a. `bases subscribe --trigger --agent <id> [--session] [--message]` MUST
    check the agent and session before any Console call, then create (or
    reuse, for the same topic, filter and agent) a local trigger on
    `ravi.console.inbox.item` filtered on `data.category == "bases"`, the base
    id, `data.payload.subscriptionId` for a filtered subscription (or the
    absence of one for an unfiltered subscription, so one item wakes one
    trigger) and the event types, sorted (the Console sorts a filter's
    events, so any `--events` order reuses the same trigger). With a `row.*`
    event the types also include `bases.rows.bulk_changed`, and with
    `agent.requested` also `bases.agent.backfill`, because a bulk write sends
    those to such a subscription instead of per-row items. From an agent turn
    (`hasRuntimeInvocationContext`) the trigger MUST be created disabled and
    the output MUST name `ravi triggers enable <id>`; from the operator's
    terminal it is enabled. JSON output includes `trigger {id, enabled, draft,
    filter, enableCommand}`.
16. CLI output (help text, plan `effect`, `suggestedAction`, messages) and the
    `bases` skill MUST NOT send people to a Console UI for Bases. Destructive
    plans name the generated Pages and charts that stop working.
17. The `bases` and `pages` skills MUST tell agents to ship generated pages with `--uses` listing
    the `ravi.bases.*` ids that page's own route calls (the host allows the
    union of the `uses` of its active routes, so a ship of another route never
    removes them), to ship data pages only with `pages ship` (`pages publish`
    and `artifacts publish` declare no `uses` for that route), and MUST NOT
    tell pages to embed row data, tokens, or Console API calls. When an agent adds a `page_viewer` principal, the skill
    MUST tell it to say which host gains which access to which view.
    The data-page guide lives in the `pages` skill
    (`ravi skills show pages --file references/data-pages.md`);
    `bases/references/pages.md` is only a pointer to it.
18. The default skill gate `bases` (`/^bases(?:[._]|$)/` → `ravi-system-bases`)
    MUST load the skill for `ravi bases …` and every `bases.*` subgroup and
    tool. Any identity that can run a `bases` command (`admin:system:*`,
    `execute:group:bases`, `read|mutate:bases[.<sub>]:<action>`) MUST also be
    able to read the skill.
19. `bases views bind <base> <view> <widget-ref|none> [--field k=col ...]
    [--variant <v>]` MUST read the view, then PATCH the full current layout
    (the Console replaces it wholesale) with only `layout.widget` changed, at
    the version it read. The widget is `{ref}` (or `{itemId}` for a UUID)
    plus `fields` and `variant` when given; `none` sends `null`. A layout
    other than board, list, gallery or calendar MUST fail `PAYLOAD_INVALID`
    (exit 2) without a write; malformed or duplicate `--field`, and
    `--field`/`--variant` with `none`, fail before any Console call. The
    Console checks the widget, the mapped columns and the variant. Access is
    `mutate:bases.views:update`, like `views update`.
20. `bases views share <base> <view> --site <slug|id|hostname> [--write a,b]
    [--create] [--archive] [--write-only]` MUST read the full view (a caller
    without manage fails `PROJECT_ACCESS_DENIED` without a write), resolve the
    site from the project's Pages sites (unknown: `NOT_FOUND`), add
    `{kind: "page_viewer", siteId}` to `access.read` (not with
    `--write-only`, which needs a write grant) and, with a write grant, to
    `access.write.principals`, merging columns and flags without removing any,
    then PATCH `access` at the version it read. Widening access is an
    authority escalation: without `--execute` it MUST dry-run (exit 3) with a
    plan of the view, the site (id and host), the grants and the disclosure,
    after reading the view and site (so an unknown site or a caller without
    manage still fails with exit 1). Nothing changed: no PATCH, no brake and
    `changed: false`. The payload and human output MUST carry the disclosure:
    which host gains which access to which view, and that the write block is
    shared by every write principal. Access is `mutate:bases.views:update`
    (risk high, confirmation required).
21. Approvals: `props add --type approval` takes `--approvers`
    (`role:<viewer|developer|project_admin>` or `user:<id>`, 1-20) and
    `--reset-on`. `rows request-approval` writes `"pending"`; `rows approve`
    and `rows reject` write `{state, note?}` and MUST dry-run (exit 3) without
    `--execute` (risk high, no default grant). All three take `--note` (at most
    1000 chars), `--view` and `--expected-version`. Without
    `--expected-version` the write sends `lastWriteWins: true` and MUST NOT
    send a version it read: the Console hashes `expectedVersion` into the
    keyed request, so a read-derived version would turn a retry after a lost
    response into `idempotency_conflict` instead of a replay. The approve and
    reject dry-runs MUST read the row first (an unknown row fails with exit 1,
    not 3) and plan its current version; the plan MUST NOT copy the note
    (only `{present, length}`). The Console decides who may approve; `approval_forbidden` maps to
    `PROJECT_ACCESS_DENIED` with that reason in the envelope.
22. Agent columns: `props add --type agent` takes `--instructions` (1-4000),
    `--inputs` (1-20 keys), `--output`
    (`text|number|checkbox|select|multi_select|url|date`, select outputs need
    `--options`) and `--agent` (a label). `rows fill <base> <row> <prop>
    --inputs-hash <16 hex> (--value <v> | --error <msg>)` posts to
    `.../rows/<row>/agent/<prop>` with an idempotency key; `--value` is JSON
    when it parses, otherwise text. `agent_stale` maps to `CONFLICT` and
    surfaces the current `inputsHash`; its `suggestedAction` MUST say to
    re-read the row, recompute from its current inputs and fill with the hash
    read, never to store the old result under the new hash. `rows rerun` posts to
    `.../agent/<prop>/rerun`.
23. The runtime bootstrap floor MUST grant exactly the Bases reads through
    views and charts: `read:bases:list|show`,
    `read:bases.views:list|show|query`, `read:bases.charts:list|show|data`.
    Direct row reads (`bases.rows:query`, `bases:aggregate`) and every Bases
    write stay opt-in.

## Write classification

| op | class | brake |
|---|---|---|
| `bases archive`, `bases restore` | base becomes read-only/hidden or writable again | local dry-run + `--execute` |
| `bases rows purge` | hard delete of a row and its ledger, irreversible | local dry-run + `--execute` |
| `bases views archive` | charts and generated Pages (forms included) using the view stop working | local dry-run + `--execute` |
| `bases charts archive` | generated Pages that render the chart stop working | local dry-run + `--execute` |
| `bases props update` (type or includeTime change) | data migration | Console dry-run report; `--execute` sends `confirm: true` |
| `bases props delete` | soft delete with dependents | Console dry-run report; `--execute` sends `confirm: true` |
| `bases rows import` | bulk create | local plan after schema read; `--execute` |
| `bases rows approve`, `bases rows reject` | a decision others act on | local dry-run + `--execute` |
| `bases views share` (when it changes access) | a Pages host gains read or write access to the view | local dry-run + `--execute` |
| `bases subscribe --trigger` | local automation | none; from an agent turn the trigger is created disabled |
| `bases create/update`, `props add/restore`, `rows add/update/archive/restore/request-approval/fill/rerun`, `views create/update/bind`, `charts create/update`, `subscribe/unsubscribe` | reversible or versioned writes | none |

## Commands

- `ravi bases list|show|create|update|archive|restore|aggregate|subscribe|unsubscribe|subscriptions`
- `ravi bases props list|add|update|delete|restore`
- `ravi bases rows query|get|add|update|archive|restore|purge|history|import|export|request-approval|approve|reject|fill|rerun`
- `ravi bases views list|show|create|update|bind|share|archive|query`
- `ravi bases charts list|show|create|update|archive|data`

`list` commands use offset pagination (`--limit`, `--offset`, `--fields`);
row queries and history use cursor pagination (`--limit`, `--cursor`).

## Generated Pages

The UI path is a generated Ravi Page. The OSS side only documents the public
connector contract; admission, view policy, and redaction stay in the Console
(`.ravi/specs/console/pages/connectors/SPEC.md` in the Console repo). All
actions are revision 1, take strict input, and act through a view that grants
`{kind: "page_viewer", siteId}` for the page's site:

| id | input | output |
|---|---|---|
| `ravi.bases.views.describe` | `{viewId}` | `{id, baseId, name, description, layout, version, columns, capabilities, valid}` |
| `ravi.bases.views.query` | `{viewId, filter?, sort?, limit?, cursor?}` | `{columns, rows, nextCursor, users}` |
| `ravi.bases.views.version` | `{viewId}` | `{fingerprint}` |
| `ravi.bases.views.rows.get` | `{viewId, rowId}` | `{rowId, version, values, body?, users}` |
| `ravi.bases.views.rows.create` | `{viewId, values, body?, idempotencyKey}` | `{rowId, version}` |
| `ravi.bases.views.rows.update` | `{viewId, rowId, values, body?, expectedVersion, idempotencyKey}` | row `{rowId, version, values, body?}` |
| `ravi.bases.views.rows.archive` | `{viewId, rowId, expectedVersion}` | `{rowId, version}` |
| `ravi.bases.charts.data` | `{chartId}` | `{chart, groups, fields, suppressedGroups, users}` |

- The page calls same-origin `POST /_ravi/connectors/exec` with `{id, input}`
  and gets `{ok: true, id, revision, output}` or `{error}`. `validation_failed`
  may carry `fieldErrors`; `version_conflict` may carry `current`. A viewer
  the view admits only to write gets `{rowId, version, values: {}}` from
  `rows.update` and in `current`.
- `ravi.bases.*` is never implicitly allowlisted: an id no active route of
  the host declared fails with `connector_not_allowlisted`.
- `charts.data` returns the groups as `groups`; the CLI `bases charts data`
  returns the same groups as `data`.
- Pages callers never manage a base. `project_role` and `user` principals do
  not admit on Pages; `page_viewer` admits only on Pages.

## Official error cases

| case | code | exit |
|---|---|---|
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + `plan` | 3 |
| bad flag value, bad JSON, CSV type mismatch, missing concurrency choice | `PAYLOAD_INVALID` | 2 |
| Console validation (`validation_failed`, `invalid_filter`, `unknown_property`, ...) | `PAYLOAD_INVALID` + `consoleError` | 2 |
| unknown base, row, view, or chart | `NOT_FOUND` | 1 |
| stale `--expected-version` | `VERSION_CONFLICT` + `current` | 1 |
| slug/key taken, idempotency or schema-version conflict | `CONFLICT` + `consoleError` | 1 |
| no Bases scope or no access | `PROJECT_ACCESS_DENIED` (+ `missingScopes`) | 1 |
| decision by someone who is not an approver | `PROJECT_ACCESS_DENIED` + `consoleError: approval_forbidden` | 1 |
| `rows fill` with a stale `--inputs-hash` | `CONFLICT` + `consoleError: agent_stale` + `inputsHash` | 1 |
| no credentials or `--console` mismatch | `AUTH_REQUIRED` | 1 |

## Validation

- `bun test src/bases/ src/cli/commands/bases.test.ts` green.
- `bun test src/inbox/ src/permissions/runtime-bootstrap-provider.test.ts src/triggers/__tests__/topic-catalog.test.ts src/triggers/__tests__/runner-filter.test.ts` green.
- `bun test src/cloud-auth/ src/cli/commands/link.test.ts` green (409 mapping).
- `bun test src/cli/confirmation-policy.test.ts src/cli/commands/json-coverage.test.ts src/cli/commands/pagination-coverage.test.ts src/sdk/client-codegen/return-schema-coverage.test.ts` green.
- `make quality` clean.

## Known Failure Modes

- An older login lacks `console.bases.read`/`console.bases.write`; every call
  fails with `PROJECT_ACCESS_DENIED` until `ravi login` runs again.
- A cursor is bound to its query. Changing `--filter` or `--sort` while
  passing `--cursor` fails with `cursor_invalid`.
- `--sort` and `--group-by` take one comma-separated value
  (`--sort prazo,horas:desc`, `--group-by status,prazo:month`). A placeholder
  ending in `...` after a non-word character made the gateway schema an array
  while commander passed a string, so both flags failed from agent sessions.
- Re-running an import with a different `--batch` reuses keys with other
  bodies; the Console answers `CONFLICT` (`idempotency_conflict`) instead of
  creating duplicates.
- A generated page shows `not_found` while `views query` works from the CLI:
  the view does not grant `page_viewer` for that site (CLI callers are admitted
  by `project_role`/`user`, pages only by `page_viewer`).
- Before Console #44 the Pages `uses` allowlist was the last ship's list for
  the whole host, and skills taught shipping the union of every route's ids.
  The host now allows the union over its active routes; a page republished
  with `pages publish` loses only its own route's ids.
- A `--trigger` created from an agent turn stays disabled until the operator
  runs `ravi triggers enable <id>`; the subscription itself is active, so
  items land in `ravi inbox items` meanwhile.
- The trigger `--trigger` creates does not filter `data.actor.type`. An agent
  that writes the same base must add that condition (`ravi triggers set <id>
  filter ...`) or subscribe only to events its writes do not produce.

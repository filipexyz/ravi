# Bases agent-first CLI contract / CHECKS

## Checks

- `src/cli/remote-gateway.test.ts` MUST preserve the public `ACTOR_UNKNOWN`
  message, action, typed reason and correlation over HTTP, and strip unsafe
  details; errors from Console MUST retain locally mapped catalog copy.
- `src/channels/slack/thread-lifecycle.test.ts` MUST retain the verified
  human requester through bootstrap and classify that contact for Bases.

- The first `ravi bases …` call in an agent session MUST return
  `RAVI_SKILL_REQUIRED` naming `ravi-system-bases` and deliver the skill; the
  retry MUST pass. `bases_rows_query` MUST resolve the same gate.
- A `full-access` agent MUST be able to run `ravi skills show bases`.
- `bases rows purge`, `bases archive`, `bases restore`, `bases views archive`,
  and `bases charts archive` without `--execute` MUST exit 3 with
  `WRITE_REQUIRES_EXECUTE` and a `plan`, and MUST NOT call the Console.
- `bases rows purge --execute` MUST POST `.../rows/<row>/purge` with
  `{confirm: true}` and no client hint.
- `bases props delete` without `--execute` MUST send no `confirm`, and MUST
  exit 3 with the Console migration report in `plan.migration`; with
  `--execute` it MUST send `confirm: true`.
- `bases rows add` MUST send the same key in the `Idempotency-Key` header and
  in `idempotencyKey`; `--idempotency-key` MUST override it and a malformed key
  MUST fail with `PAYLOAD_INVALID` before any request.
- Inside an agent session, `bases rows add` and `bases rows update` without
  `--idempotency-key` MUST still write and MUST return `warnings`; with the
  key, or outside an agent session, they MUST return no `warnings`.
- `bases rows query --sort a:desc,b` and `bases aggregate --group-by
  status,prazo:month` MUST pass through the daemon gateway (one string value).
- `bases rows update` without `--expected-version` or `--last-write-wins` MUST
  fail with `PAYLOAD_INVALID` (exit 2) before any Console call.
- A Console `VERSION_CONFLICT` MUST return exit 1 with `consoleError`,
  `requestId`, `current`, and a `suggestedAction` naming the current version.
- Console `details.fieldErrors` MUST appear as `issues` with path
  `["values", <key>]`.
- `PROJECT_ACCESS_DENIED` with stored scopes lacking the Bases scopes MUST
  return `missingScopes` and a `suggestedAction` that mentions `ravi login`.
- A bare HTTP 409 MUST map to `AUTH_PENDING` on `/api/cli/auth/*` and to
  `CONFLICT` on `/api/cli/projects/*/bases/*`; a 409 `CONFLICT` on
  `/api/cli/link` MUST still map to `ACTOR_BINDING_CONFLICT`.
- `bases rows query --all --max-rows N` MUST send identical bodies except
  `cursor` and MUST stop after the page that reaches N.
- `bases rows import` MUST fail with `PAYLOAD_INVALID` on type mismatches
  before the brake, MUST exit 3 with a plan without `--execute`, and MUST use
  the same batch keys when the same command runs again.
- `bases views bind` MUST GET the view, then PATCH the full layout with only
  `widget` changed and `expectedVersion` set to the version read; `none` MUST
  send `widget: null`; a table layout MUST exit 2 with no PATCH (`ravi bases
  views bind` block of `src/cli/commands/bases.test.ts`).
- Every `bases` command MUST pass the confirmation, JSON, pagination, and
  return-schema coverage tests.
- `publishInboxNatsEvents` MUST publish a `category: "bases"` item only on
  `ravi.console.inbox.item`, unchanged.
- No `bases` help text, plan `effect`, `suggestedAction`, or message may point
  to a Console UI for Bases; `bases charts archive` and `bases views archive`
  plans MUST name the generated Pages that stop working
  (`grep -n "Console" src/cli/commands/bases.ts` shows only project, scope,
  URL, and server-side wording).
- The `bases` and `pages` skills MUST name only the eight `ravi.bases.*` ids listed in
  SPEC "Generated Pages". Every page example MUST ship with `--uses` covering
  the ids its own route calls, and the skills MUST say that the host allows
  the union over its active routes (no skill, reference, skeleton or doc may
  still teach "every ship lists the union of every page's ids":
  `grep -rn "união do --uses\|união dos ids de todas\|union of the ids all" src/plugins docs AGENTS.md src/prompt-builder.ts`
  finds nothing).
- The skill MUST tell the agent, when it grants `page_viewer`, to tell the
  person which host (all routes) gains read or write access to which view.
- `bases create`, `props add`, `views create` and `charts create` MUST send
  the same key in the `Idempotency-Key` header and in `idempotencyKey`, with
  no `clientHint` (`creates with idempotency keys` block of
  `src/cli/commands/bases.test.ts`).
- Inside a runtime turn, Bases reads (GET and POST `rows/query`,
  `views/<v>/query`, `charts/<c>/data`) and writes MUST carry
  `x-ravi-actor-contact`; outside a turn none (`Bases reads in a delegated
  turn` block of `src/bases/client.test.ts`).
- `bases subscribe --events/--props/--view` MUST post the filter body;
  unknown events, more than 20 props, and trigger-only flags without
  `--trigger` MUST fail `PAYLOAD_INVALID` before any call.
- `bases subscribe --trigger` from the operator MUST create an enabled
  trigger; from an agent turn a disabled one with `enableCommand`; the same
  subscription again MUST reuse the trigger. The filter MUST match only its
  own subscription's items (`Bases subscription triggers` in
  `src/triggers/__tests__/runner-filter.test.ts`).
- Inside a runtime turn Ravi cannot attribute, every Bases command (reads
  included) MUST fail `ACTOR_UNKNOWN` (exit 3) with no Console call
  (`src/bases/client.test.ts`, `src/cloud-auth/turn-actor.test.ts`).
- A run of a cron job a contact owns MUST send that contact as the actor
  (`x-ravi-actor-contact`, access body `actor`), never refuse locally and
  never act as the operator (`src/access/actor.test.ts`,
  `src/cloud-auth/turn-actor.test.ts`); unlinked, the link flow MUST answer
  `routine` without messaging anyone (`src/identity-link/turn-link.test.ts`,
  `src/cloud-auth/errors.test.ts`).
- A run of a cron job no person owns (`unknown`, an agent) MUST fail `ACTOR_UNKNOWN` with
  `refusalReason: routine_not_operator_owned`, its `jobId` and `ownerPrincipal`, and
  a suggested action that does not send the agent to the person's chat
  (`src/cli/commands/bases.test.ts`, `src/access/actor.test.ts`). A remote
  `ACTOR_UNKNOWN` MUST keep the catalog copy even with a `reason` in its
  details (`src/cloud-auth/errors.test.ts`).
- A shell cron process (`RAVI_AUTOMATION_PRINCIPAL=automation:cron:<id>`, no
  context key) MUST count as a runtime turn: an operator-owned one sends no
  actor, and the classification of a marker naming a contact-owned job sends
  that contact or, ownerless, fails `ACTOR_UNKNOWN` with
  `routine_not_operator_owned` (such a job never runs: connectors 13b); shell
  triggers and jobs MUST NOT be covered
  (`src/cloud-auth/turn-actor.test.ts`).
- An agent turn a trigger fired MUST act in Bases as the trigger's owner
  (6b): an operator-owned trigger sends no actor, a contact-owned one sends
  that contact on the project lookup and the Bases calls, a trigger no person
  owns fails `ACTOR_UNKNOWN` with `routine_not_operator_owned`,
  `routine: trigger`, the trigger id in `jobId` and its `ownerPrincipal`
  before any Console call, and a turn without a valid snapshot fails
  `ACTOR_UNKNOWN` `unknown` (`src/bases/client.test.ts`, through the default
  client and the process's own fetch; `src/cloud-auth/turn-actor.test.ts`;
  `src/access/actor.test.ts`).
- An owned trigger MUST lend its owner only in its own session (6b). The
  runner MUST run an `isolated` trigger a person owns in the session under
  `agent:<agent>:trigger:<id>:own`, found by key alone and going by that
  key as its only name, starting after whatever the journal already holds
  under it, and name that key in the snapshot
  (`ownSessionKey`); a trigger nobody owns keeps the plain session and its
  plain name, and the agent's main session and a named session (the one the
  trigger creates included) name no session (`null`). A trigger that loses
  its owner MUST move to the plain session, before and after the runner
  reloads it, and the own session MUST receive nothing more
  (`src/triggers/__tests__/runner-owner.test.ts`,
  `src/triggers/__tests__/ownership.test.ts`).
- The own session's name MUST stay its own: no session can be created
  under it, with it or renamed to it once the own session is deleted, the
  own session cannot be renamed, and the trigger's next fire takes the name
  again and starts after what the deleted session journaled
  (`src/triggers/__tests__/runner-owner.test.ts`,
  `src/router/sessions.test.ts`).
- The own session's name MUST be one subject token whatever the agent id:
  a dot, whitespace, `*`, `>` and `~` are written as `~<code>~`, different
  keys give different names, and the store, the runner and the intake agree
  on it (`src/triggers/__tests__/ownership.test.ts`,
  `src/triggers/__tests__/runner-owner.test.ts`,
  `src/router/sessions.test.ts`, `src/runtime/session-dispatcher.test.ts`).
- An own session whose row has no history mark MUST get it on the next fire,
  before its first turn, and keep it afterwards
  (`src/triggers/__tests__/runner-owner.test.ts`).
- A chat id MUST NOT resolve to an own session (`src/router/sessions.test.ts`).
- A trigger on a wildcard topic MUST NOT fire on a `ravi.session.*`,
  `ravi._reply.*` or `ravi.worker.*` event, and MUST still fire on any other
  (`src/triggers/__tests__/runner-owner.test.ts`). The audit event of a
  command run in an own session MUST NOT fire a trigger, and one run in any
  other session MUST, with the payload the CLI really builds inside the
  command's context and the one the gateway builds outside it
  (`src/triggers/__tests__/runner.test.ts`); the gateway MUST mark only a
  context whose session is a trigger's own
  (`src/sdk/gateway/dispatcher.test.ts`).
- A shell trigger's failure notice MUST NOT be sent into a trigger's own
  session (`src/triggers/__tests__/runner-owner.test.ts`), and
  `--on-error notify-session:<own session>` MUST be refused
  (`src/cli/commands/triggers.test.ts`).
- No other fire MUST run in a trigger's own session: a trigger pointed at
  it by name, by key or by a value from the event is skipped, the same
  owner's included; a `main` trigger whose reply session is an own session
  runs in the main session; the plain session of a trigger nobody owns
  still takes other triggers' fires as before
  (`src/triggers/__tests__/runner-owner.test.ts`). `triggers add`,
  `triggers set session` and `bases subscribe --trigger` MUST refuse a
  literal `--session` that is another trigger's own session, and default to
  the main session when the creating turn runs in one
  (`src/cli/commands/triggers.test.ts`, `src/cli/commands/bases.test.ts`).
  The refusal MUST hold before that session exists, and the runner MUST skip
  a fire pointed at such a name without creating a stand-in session
  (`src/triggers/__tests__/ownership.test.ts`,
  `src/triggers/__tests__/runner-owner.test.ts`).
- The classification MUST require the turn to run in the session the
  snapshot names and that session to be the own session of the turn's own
  trigger (not the plain one, a named one, another trigger's own, a thread
  of it, a chat's or the main session), and MUST fail `ACTOR_UNKNOWN` with
  `routine_shared_session` before any Console call otherwise
  (`src/link/connector-turn.test.ts`, `src/access/actor.test.ts`,
  `src/cloud-auth/turn-actor.test.ts`, `src/bases/client.test.ts`).
- A trigger's own session MUST stop lending its owner once a conversation
  is wired into it: a direct chat or a group attached (as an input only too,
  its owner's own direct chat included), or a route that sends chats into it
  by name (`src/link/connector-turn.test.ts`), also when the chat is
  attached while the turn runs
  (`src/runtime/runtime-request-builder.trigger-owner.test.ts`).
- The dispatcher's intake MUST admit into an own session only its trigger's
  fires and the runtime's restart notice that names that session, and drop a
  relay, another trigger's fire, a failed shell command's notice (the same
  trigger's included), a restart notice for another session or for none, a
  cron run, a hook action, a heartbeat, a typed message and a prompt that
  only claims to be a trigger's as `intake_failed:trigger_own_session`, also
  when the stored session is gone and only a runtime, or only the name, is
  left; a decision delivery MUST be rejected; every other session, a
  trigger's plain and named ones included, MUST admit prompts as before
  (`src/runtime/session-dispatcher.test.ts`,
  `src/triggers/__tests__/ownership.test.ts`).
- Hooks MUST NOT run for an own session's events, by key or by name, also
  when its row is gone, and `append_history` MUST NOT write to it
  (`src/hooks-runtime/runner.test.ts`).
  A `main` cron job whose reply session is an own session MUST run in the
  main session, and `cron add` in an own-session turn MUST store no reply
  session (`src/cron/runner.test.ts`,
  `src/cli/commands/cron-commands.test.ts`). `sessions send` MUST refuse an
  own session as a target (`src/cli/commands/sessions.test.ts`).
- A session name shaped like a session key MUST be only the session's own
  key, at creation and on `updateSessionName`
  (`src/router/sessions.test.ts`, `src/triggers/__tests__/runner-owner.test.ts`).
- A trigger's session key (`agent:<agent>:trigger:<id>`, its `:own` form
  and its `:key:<24 hex>` form, nothing derived from them) MUST be
  creatable by the trigger runner only: every other creation is refused,
  and `sessions send <name> -a <agent>` says the name is reserved
  (`src/router/sessions.test.ts`, `src/cli/commands/sessions.test.ts`).
- An owned trigger whose recorded reply target is a chat (its owner's own
  included), is `unresolved`, or is missing MUST fail `ACTOR_UNKNOWN` with
  `routine_answers_elsewhere` before any Console call; only the recorded
  target counts, not the chat the prompt names as its source
  (`src/link/connector-turn.test.ts`, `src/access/actor.test.ts`,
  `src/bases/client.test.ts`).
- Through the real turn start, a fire that lends its owner's authority MUST
  record `turnReplyTarget: none` and post to no chat when no chat is bound,
  stay so when a chat is attached to its session during the turn (and be
  refused from then on), and be refused when a chat is the session's output
  or feeds it, its owner's own direct chat included; a fire that lends
  nothing
  (a chat's session, another session than the one it was sent to, no owner,
  no snapshot) MUST be delivered as before and refused
  (`src/runtime/runtime-request-builder.trigger-owner.test.ts`).
- The refusal and the actor header MUST come from one classification
  (`resolveTurnActor`), and a refused turn names no contact
  (`src/cloud-auth/turn-actor.test.ts`).
- Callers other than Bases MUST refuse every trigger turn and name no
  contact for it, whoever owns the trigger; the connector classification
  MUST stay `CONNECTOR_SPEAKER_NOT_OWNER` with the same message
  (`src/link/connector-turn.test.ts`, `src/access/actor.test.ts`,
  `src/cloud-auth/turn-actor.test.ts`).
- The trigger snapshot MUST be read only from the host-issued turn context:
  a child inherits it, child-supplied authority is ignored, and a snapshot
  that says `operator` for an owner that is not is not promoted
  (`src/link/connector-turn.test.ts`). The turn context MUST record it
  (`src/runtime/runtime-request-context.test.ts`) and a continuation MUST
  keep it (`src/runtime/delivery-queue.test.ts`).
- The runner MUST admit the stored row's owner only for the definition it
  subscribed: an edit not reloaded yet (the owner's own included), a change
  someone else made, and a deleted row all fire with no owner, and a test
  fire is admitted only for the owner's own test
  (`src/triggers/__tests__/runner-owner.test.ts`).
- A fire whose snapshot lends authority (a person owner and a session of
  its own) MUST be its own turn: never folded in the pending queue or the
  debounce batch with another trigger's prompt or an actor-less inform, in
  either order; never given held `!!` text or a deferred session bootstrap;
  never steered while running; and a restart prompt combining several
  stashed prompts carries no snapshot. A person's trigger fired into a
  session that is not its own, and a malformed snapshot, MUST be delivered
  as before (`src/runtime/delivery-queue.test.ts`,
  `src/runtime/session-dispatcher.test.ts`). The turn that resumes after a
  context recovery MUST carry no snapshot
  (`src/runtime/slack-context-recovery.test.ts`).
- The owner MUST be written only on create and cleared by every update that
  is not owner-neutral unless its owner makes it; no update gives a trigger
  an owner; a row with no owner reads as `unknown`, never the operator
  (`src/triggers/__tests__/triggers-db.test.ts`,
  `src/triggers/__tests__/ownership.test.ts`,
  `src/router/router-db.trigger-session-check.test.ts`). `triggers add`,
  `bases subscribe --trigger` and `watch trigger` MUST record the creating
  turn; `triggers set` and `enable` MUST warn when they took the owner away;
  `triggers show` and `bases subscribe --trigger` MUST carry `ownsSession`
  (`true` only for `--session isolated`) and say when an owned agent
  trigger's session is not its own
  (`src/cli/commands/triggers.test.ts`, `src/cli/commands/bases.test.ts`,
  `src/cli/commands/watch.test.ts`). Those tests MUST NOT read this
  machine's `ravi login`, link cache or sessions to decide any of it.
- An unlinked contact who owns the trigger MUST get `linkFlow: routine` from
  a Bases refusal, with nobody messaged
  (`src/identity-link/turn-link.test.ts`); the refusals' copy MUST name the
  trigger and survive the remote gateway, an `automation:` owner included
  (`src/cloud-auth/errors.test.ts`, `src/cli/remote-gateway.test.ts`).
- `bases views share` without `--execute` MUST exit 3 after reading the
  view and site, with no PATCH; with it, it MUST PATCH `access` at the
  version read with the `page_viewer` added, MUST NOT PATCH when nothing
  changes, MUST fail
  `NOT_FOUND` for an unknown site and `PROJECT_ACCESS_DENIED` for a caller
  without manage, and MUST return the disclosure.
- `bases rows approve|reject` without `--execute` MUST read the row and exit 3
  without a write (an unknown row exits 1), with no note text in the plan;
  `request-approval|approve|reject` without `--expected-version` MUST send
  `lastWriteWins: true` and no read-derived `expectedVersion`, so the same
  key retries as the same request; with `--execute` they MUST write `{state, note?}` (through the view
  with `--view`). `approval_forbidden` MUST surface as
  `PROJECT_ACCESS_DENIED` with `consoleError: approval_forbidden`.
- `bases rows fill` MUST post `{inputsHash, value|error}` with an idempotency
  key; `agent_stale` MUST return `CONFLICT` with the current `inputsHash`.
- The bootstrap floor MUST hold exactly the eight Bases read capabilities of
  SPEC invariant 23 and no `mutate:bases*`, `read:bases.rows:query` or
  `read:bases:aggregate` (`src/permissions/runtime-bootstrap-provider.test.ts`).
- Inbox enrichment MUST add `payload.row` to `bases.approval.*` and
  `bases.agent.requested` items and MUST NOT read a row for
  `bases.rows.bulk_changed` or `bases.agent.backfill`.

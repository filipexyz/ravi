---
id: routines/triggers
title: "Trigger Topics And Filters"
kind: capability
domain: routines
capability: triggers
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/triggers
  - src/cli/commands/triggers.ts
  - src/plugins/internal/ravi-system/skills/triggers/SKILL.md
tags:
  - routines
  - triggers
  - nats
  - topics
  - filters
---

# Trigger Topics And Filters

## Intent

Trigger topics are the event subjects a routine can observe. The trigger topic catalog is the durable bank of examples, schemas, default message templates, notes, and patterns that humans and agents should consult before creating a trigger.

Trigger filters are the deterministic pre-agent predicate for event payloads. They prevent avoidable agent runs and MUST be safe to evaluate without `eval` or arbitrary code execution.

## Invariants

- Trigger-ready Ravi-maintained subjects SHOULD be registered in `src/triggers/topic-catalog.ts`.
- Trigger examples in docs, skills, and CLI help MUST use cataloged subjects unless they are explicitly marked as custom publisher subjects.
- Channel transport aliases such as `whatsapp.*.reaction`, `whatsapp.*.inbound`, and `matrix.*.inbound` MUST NOT be documented as trigger-ready subjects unless a Ravi publisher actually emits them.
- Emoji reaction triggers MUST use `ravi.inbound.reaction` until a different subject is deliberately added to the catalog and publisher.
- Reaction trigger payloads MUST be documented as correlation events, not full chat/message records. The current `ravi.inbound.reaction` payload identifies `{ targetMessageId, emoji, senderId }`; it does not guarantee `chatId`, message caption, media metadata, or domain state.
- Routines that need to publish or approve domain objects from a reaction MUST persist a durable mapping keyed by the outbound message external id before waiting for the reaction. The trigger handler MUST resolve `targetMessageId` against that state and stay silent when there is no match.
- The CLI MUST NOT block custom NATS subjects. It SHOULD warn when a subject is outside the built-in catalog or looks like a known inferred alias without a Ravi publisher.
- The catalog MUST expose a machine-readable payload schema for Ravi-maintained trigger-ready subjects.
- Catalog schemas MUST describe safe agent-facing payload fields with `path`, `type`, `required`, and `description`.
- Catalog schemas MUST NOT require agents to infer fields from prose-only payload strings.
- The catalog SHOULD include a default message template when a subject has an obvious safe agent-facing notification.
- Catalog default message templates MUST use the trigger template syntax accepted by the runtime, currently `{{topic}}` and `{{data.<path>}}`.
- `ravi triggers add` MAY omit `--message` only when the selected topic matches a catalog entry with a default message template.
- `ravi triggers add` MUST persist catalog-template provenance for catalog defaults so runtime formatting does not depend only on comparing message strings.
- `ravi triggers add` MUST still reject missing `--message` for custom subjects or catalog entries without a default template.
- Default message templates MUST be concise, action-oriented, and point agents at a local Ravi CLI command when the event references a durable local object.
- Trigger prompts built from catalog default message templates MUST use a standardized header and MUST NOT include the raw `Data: <json>` block.
- The standardized catalog-template prompt header MUST identify both that the prompt came from a trigger and which event fired it:
  - `[Trigger: <trigger name>]`
  - `Event: <event topic>`
- Manual/custom trigger prompts MUST carry the event as compact `key: value` lines under `Data:` (a debounced batch: `Events:`, one numbered entry per event), nested objects flattened with dotted keys, multi-line values folded onto one line, each value cut at 500 characters and at most 40 lines per event (the rest summarized in one line that points at `{{data}}`). A watch event (`ravi.watch.*`, the `WatchNatsPayload` envelope) MUST show its `subject` (with the watch name), `at` (when it happened), its `payload` and its `links`, and MUST NOT carry `eventId`, `dedupeKey`, `source`, `delivery` or `createdAt`: they repeat the payload or matter to nobody reading the turn.
- A trigger message that writes `{{data}}` (alone, not `{{data.<path>}}`) MUST get the full event as indented JSON in that place, and the prompt MUST then carry no other copy of the event; in a debounced batch the last event is listed in `Events:` by topic only, pointing at the JSON. That is the only way to ask for the raw envelope. Placeholders are resolved in the message text only: text inside the inserted event (a comment that writes `{{topic}}`) MUST reach the prompt unchanged.
- Every line the compact rendering adds MUST obey the same value cap and newline folding, the watch subject, watch name, time and links included. Keys MUST be folded like values: no text from the event (key or value, any line break: `\n`, `\r`, vertical tab, form feed, NEL, U+2028, U+2029) may start a line of the prompt, where it could pass for a header such as `[System] Execute:`. Other control characters are dropped.
- Native local inbox events MUST be distinct from Console delivery mirror events. Email automations SHOULD listen to `ravi.inbox.mail.received`; `ravi.console.inbox.item` is a technical mirror and MUST NOT be documented as the durable local email subject.
- The catalog SHOULD include payload schema, default message template when available, example command, common filters, and operational notes for each subject.
- Trigger filters MUST support the comparison operators `==`, `!=`, `startsWith`, `endsWith`, and `includes`.
- Trigger filters MUST support boolean composition with `&&`, `||`, unary `!`, and parentheses.
- Trigger filter precedence MUST be `!` before `&&` before `||`.
- Trigger filter values MUST be quoted strings; event values are coerced to strings for comparison.
- Trigger filter evaluation MUST NOT use JavaScript `eval`, `new Function`, or shell execution.
- The CLI MUST reject invalid filter syntax before persisting a new or updated trigger filter.
- Runtime evaluation MUST fail closed for persisted filters that do not compile: the runner MUST NOT activate the trigger (no subscription entry, no agent prompt, no shell command) and MUST log an error with the trigger id and parse error. A broken filter MUST NEVER widen matching.
- Compiled invalid filters MUST evaluate to no-match, so consumers that skip the validity check still fail closed.
- `ravi triggers list` and `ravi triggers show` MUST expose the runner's activation verdict (`runtimeState`: `active`, `disabled`, `invalid_filter`, `blocked_topic`, `unbound_agent`) and, for invalid filters, the parse error (`filterError`). Both surfaces MUST derive it from the same activation function the runner uses.
- A trigger whose `agentId` does not resolve to an agent row MUST report `unbound_agent`. The runner MUST NOT subscribe it and MUST NOT create a session under `/tmp/ravi-<agentId>`.
- Fixing or clearing an invalid filter MUST activate the trigger on the next `ravi.triggers.refresh` without a daemon restart.
- Code that generates trigger filters programmatically (for example `gh` PR follow, bug follow, page comment follow, watch triggers) MUST emit filters that pass `validateFilter`.
- A comparison on a path the event does not carry MUST evaluate to false for every operator, `!=` included. A filter that excludes events MUST negate an equality (`!(path == value)`); `path != value` also excludes every event that lacks the path.

## Trigger Owner

A trigger is owned by the turn that created it. The owner decides who the trigger's agent turns act as in Bases; the normative rule, its limits and its refusals live in `cli/bases` invariant 6b.

- `triggers.owner_principal` MUST be written only when the trigger is created: `operator` for the terminal and the owner's own turns, else the actor principal of the creating turn (the cron rule, `cli/connectors` 13a). `ravi triggers add`, `ravi bases subscribe --trigger` and `ravi watch trigger` MUST record it. A turn Ravi cannot attribute owns nothing.
- No update MUST ever give a trigger an owner. An update that is not owner-neutral MUST clear the owner in the same statement unless the stored owner is the one making it. Owner-neutral is only `cooldown`, a shell `timeout` and disabling.
- So `ravi triggers set` (any key but `cooldown` and `timeout`) keeps the owner only in the owner's own turn. `ravi triggers enable` keeps it when the owner or the operator turns the trigger on (the operator arms someone else's draft, which still acts as that person), and clears it for anyone else. Both warn when they took the owner away. `ravi triggers disable` never touches it. Generated follows that rebind or rewrite a trigger clear it.
- A trigger with no owner MUST act as nobody: one written before owners were recorded, a generated follow, or one somebody else changed. No owner MUST NOT be read as the operator, there MUST be no backfill, and the only way to own a trigger is to create it.
- `ravi triggers show|list|add|set|enable` JSON MUST carry `ownerPrincipal` (`unknown` with no owner), `runsAsOperator` and `ownsSession` (whether the trigger is set to run in its own session, `--session isolated`); text `show` and `add` MUST print `Runs as`, for a shell trigger say that the owner is not enforced, and on the `Session` line of an agent trigger a person owns say when the session is not its own. `add` MUST warn when an agent trigger does not act as the operator.
- The runner MUST decide the owner when the trigger fires and carry it with the prompt (`_triggerAuthority`): the stored row's owner, and only while that row is still the definition the runner subscribed. `ravi triggers test` MUST name who asked (`initiator`), and a test fire MUST carry the owner only for the owner's own test. The turn that reports a shell trigger's failure MUST NOT carry it.
- `--session isolated` is one session per trigger. While a person owns the trigger (`operator`, `contact:<id>`) that session is the trigger's own, under the key `agent:<agent>:trigger:<id>:own`, which is also its only name (the session store gives that name to no other session, before the own session exists or after it is deleted, and writes out a character a name cannot hold, `sessions` spec), and it starts after whatever the journal held under that name before its first turn; for a trigger nobody owns it is the plain session `agent:<agent>:trigger:<id>`, as before owners existed. The runner MUST read the stored trigger at each fire to tell which, so a trigger that loses its owner moves to the plain session and never enters the own one again. The snapshot MUST name the own session's key (`ownSessionKey`) when the fire runs there and `null` otherwise.
- A trigger's own session runs that trigger's `isolated` fires and nothing else. A fire that reaches a session by a name, a key, a value from the event or a reply session MUST NOT run in an own session: a named or templated fire is skipped and logged, and a `main` trigger whose reply session is one runs in the agent's main session. The dispatcher's intake MUST drop every other prompt published to an own session (`cli/bases` 6b lists them), and hooks MUST NOT run for its events. `ravi triggers add` and `ravi triggers set <id> session` MUST refuse a literal session that is another trigger's own, also before that session exists, and `add` MUST default to the main session when the creating turn runs in one. A shell trigger's `--on-error notify-session:<session>` MUST be refused for an own session, and the runner MUST send no failure notice into one. Every other session, the plain session of a trigger nobody owns included, takes fires and prompts as before.
- Session keys under a trigger (`agent:<agent>:trigger:<id>`, `...:own`, `...:key:<24 hex>`) are created by the trigger runner only (`SESSION_KEY_RESERVED` for anyone else, `sessions` spec), so the key says who made the session.
- A trigger MUST NOT fire on an event of the bus's own transport, whatever pattern delivered it: `ravi.session.*` (prompts, what a session streams, its runtime events), `ravi._reply.*` (request replies) and `ravi.worker.*` (remote worker pipes). The runner checks each event's own subject, because a wildcard pattern such as `ravi.>` is not a `blocked_topic` and would otherwise hand a trigger the text any session streams. The audit event of a command run in a trigger's own session (`ravi._cli.cli.*`) MUST NOT fire a trigger either: the gateway, which dispatches a turn's commands, marks it as coming from a trigger's turn. Commands run in any other session fire triggers as before.
- A fire whose snapshot lends authority (a person owns the trigger and the fire runs in its own session) MUST run as a turn of its own: never folded with another prompt, never given held `!!` text or a deferred session bootstrap, never steered, and bound from its start to where it answers (to no chat when none is bound then). The turn that resumes after a context recovery MUST carry no snapshot. Fires that lend nothing are delivered as before.
- The owner MUST NOT change what a trigger turn may do anywhere but Bases: personal connectors, Knowledge, Pages access and cloud runs keep refusing trigger turns. No owner is enforced on shell triggers.

## Acceptance Criteria

- `ravi triggers add` from the operator's terminal stores `ownerPrincipal: "operator"` and reports `runsAsOperator: true`, with no runs-as warning.
- `ravi triggers show <id> --json` on a trigger written before owners were recorded reports `ownerPrincipal: "unknown"` and `runsAsOperator: false`, and no `ravi triggers set` changes that: the trigger is created again to get an owner.
- `ravi triggers set <id> filter '<expression>'` from anyone but the trigger's owner leaves it with `ownerPrincipal: "unknown"` and prints the warning; from its owner it keeps the owner.
- `ravi triggers set <id> cooldown 30s` and `ravi triggers disable <id>` from anyone keep the owner.
- `ravi triggers enable <id>` from the operator's terminal on a draft a contact created keeps `ownerPrincipal: "contact:<id>"`; from another agent's turn it leaves `unknown` and prints the warning.
- `ravi triggers show <id> --json` reports `ownsSession: true` for `--session isolated` and `false` for `main`, a named and a templated session; text `show` prints `(not the trigger's own session: its turns cannot use Bases; isolated can)` after the session of an agent trigger a person owns when it is `false`. Once an `isolated` trigger has fired, `show` prints the session's name (`Session: isolated (<name>)`) and JSON carries it in `isolatedSessionName`.
- `ravi sessions send <name of an own session> "text"` fails with `is the own session of trigger <id>`, and nothing is published.
- An `isolated` trigger created from the operator's terminal runs in a session whose key ends in `:own` and whose name ends in eight hex characters; after someone else runs `ravi triggers set <id> message "..."`, its next fire runs in the session `agent:<agent>:trigger:<id>` and nothing more reaches the first one.
- `ravi triggers add other --topic <t> --message <m> --session <name of that own session>` fails with `is the own session of trigger <id>`, and creates nothing.
- `ravi sessions send agent:<agent>:trigger:<id>:own "text" -a <agent>` on a name nothing answers to fails with the name reserved for the trigger that creates it, and creates no session.
- `ravi triggers topics --json` exposes the catalog in machine-readable form.
- `ravi triggers topics --json` includes `schema.fields[]` for built-in trigger-ready subjects.
- `ravi triggers topics --json` includes `messageTemplate` for topics with a safe built-in default message.
- `ravi triggers add "New local email" --topic "ravi.inbox.mail.received"` persists the catalog default message template without requiring `--message`.
- A trigger created from a catalog default stores message provenance as catalog/template metadata.
- The default `ravi.inbox.mail.received` message tells the agent a new email arrived, includes the local message id, exact display text for `De`/`Para`, and points at `ravi mail messages read <id>`.
- If the local email event includes attachment metadata, trigger prompts MAY summarize filenames/counts but MUST NOT inline attachment bytes; agents should read/download attachments through explicit mail commands.
- When the `ravi.inbox.mail.received` default template fires, the delivered prompt starts with `[Trigger: New local email]`, includes `Event: ravi.inbox.mail.received`, and does not include a raw JSON `Data:` block.
- `ravi triggers add "Custom" --topic "custom.external.>"` without `--message` fails clearly because custom subjects have no catalog template.
- `ravi triggers add --topic "whatsapp.*.reaction"` succeeds with a warning that `ravi.inbound.reaction` is the canonical built-in reaction subject.
- `ravi triggers add --topic "custom.external.>"` succeeds with a warning that the subject is custom/outside built-in templates.
- `ravi triggers add --filter 'data.chatId == "X" && (data.status == "approved" || data.status == "manual")'` persists the filter and evaluates correctly.
- Reaction approval examples filter on fields present in the reaction payload, such as `data.emoji` or `data.senderId`, and tell the agent to load domain state by `data.targetMessageId`.
- `ravi triggers set <id> filter 'data.ok == true'` fails clearly because values must be quoted.
- A persisted enabled `--shell` trigger whose filter is `data.branch == main` never runs its command, and the daemon logs `Skipping trigger with invalid filter (fail-closed)` with the trigger id.
- `ravi triggers list --json` reports that trigger with `runtimeState: "invalid_filter"`, `filterStatus: "invalid"`, a `filterError`, and a top-level `warnings[]` entry with the fix command; text mode shows `invalid_filter` in the `STATE` column.
- `ravi triggers enable <id>` on a trigger with an invalid filter succeeds but warns that the trigger will not fire.
- Skills and docs point users to the catalog instead of asking them to infer subjects by symmetry.

## PR follow recipient lifetime

- A generated `gh-follow` armed from a Slack thread belongs to that thread's child while the thread is `open`: the child's agent, session and key, with a reply source that carries the thread id, delivered into the thread (see "Reply account and channel" below and `channels/slack/threads`). It belongs to the durable parent session once the thread is closed or pruned, and closing an open thread hands its generated PR follows to the parent inside the close transaction. A parent-owned follow MUST capture the channel root as reply-source fallback, never the child's thread. A follow that is not a PR follow (`page-comment:*`) is always the parent's.
- Pending PR-number resolution MUST recover the parent from the durable lifecycle even after the child closes or is pruned. Missing/ambiguous thread lineage or a missing parent MUST fail closed; failed pending registrations MUST stay queued for retry within their existing expiry.
- Reuse and maintenance MUST reconcile existing generated follows using the saved owner's lifecycle, not a new observer's session. A repaired row MUST refresh the runner. Unrelated trigger recipients MUST NOT be changed.
- Manual Git Data API publication MUST explicitly ensure/register its follow: raw API calls alone do not pass through the `gh pr create` observer. Completion MUST verify ready state, active follow and durable reply owner.
- For `ravi pr publish`, completion verification and partial-result recovery are governed by [the canonical publication contract](../../cli/pr/SPEC.md#verified-pr-publication) and its [recovery runbook](../../cli/pr/RUNBOOK.md); the manual-publication follow-registration step above does not apply.
- API publication MUST validate the publisher's durable thread lineage before any GitHub mutation. Missing/ambiguous lineage MUST NOT create or promote a PR, register a follow at the child, or manufacture a parent from source metadata. Registration MUST resolve the original publisher again after GitHub I/O so closure/pruning during publication still hands off to the saved parent. Publication tests MUST exercise real isolated lifecycle state and CI delivery after child closure/pruning.

## PR follow event selection

- A generated `gh-follow` MUST NOT wake its owner twice for a run the local derivation reports: the outcome event (`workflow_run.succeeded`, `failed`, `cancelled`) is delivered and the `workflow_run.completed` the local derivation (`placement == "local"`) emits beside it is not. A `workflow_run.completed` that is the only event of its run (`action_required`, `neutral`, `skipped`, `stale`, no conclusion) MUST still be delivered.
- A `workflow_run.completed` the Console delivers MUST be delivered whatever its conclusion. The Console sends no outcome event, so it is the only CI signal of a follow whose local poller produces nothing (the repo watch was deactivated by someone else, `gh` cannot read the repo, the watch could not be created). When the Console and the local poller both report a run, the owner hears it twice; that is the price of never going deaf.
- A generated `gh-follow` MUST NOT deliver any run of the `PR Description` workflow, and MUST deliver every PR lifecycle event and PR comment of its PR.
- A generated `gh-follow` MUST NOT deliver a run that has not concluded (`workflow_run.requested`, `workflow_run.in_progress`): its conclusion arrives as its own event.
- A generated `gh-follow` MUST deliver a comment written by a bot: Devin's and CodeRabbit's review findings arrive as bot comments, and the author answers them before the independent review. The follow message tells the owner to stay silent on a bot comment that asks nothing.
- A workflow run event of the local derivation MUST carry the run's `url` and `headSha` in its payload, so the follow can link the CI result it reports.
- A change to the generated filter MUST reach follows that already exist. Maintenance MUST rewrite a follow's filter when it equals, exactly, one an earlier release generated for that PR, and MUST leave any other valid filter alone.

## Delivery defaults and advice

- `ravi triggers add` of an agent trigger with neither `--cooldown` nor `--debounce` MUST store cooldown off and a debounce: 30 s on a `ravi.watch.*` topic (one push yields several workflow runs), 5 s on any other. A shell trigger MUST get no default debounce: a script that reads one event (`$RAVI_TRIGGER_DATA_FILE`) would act on the last event of a batch only; it opts in with `--debounce` and reads `$RAVI_TRIGGER_EVENTS_FILE`. Without `--debounce` it MUST keep a 5 s cooldown, so a burst cannot run a host script once per event without limit. The help MUST say that a burst keeps its last 200 events and that a burst pending when the daemon stops is lost. Cooldown drops every event inside its window; debounce keeps them and fires once with the batch. An explicit `--cooldown` MUST keep its meaning alone, with no debounce added behind it. A trigger that already exists keeps its stored values. Generated follows that set their own delivery (`gh-follow`: cooldown and debounce 0) are not affected.
- `ravi triggers add` that leaves the session to the default while the creating turn is a conversation (a session with a chat), for an agent trigger with no `--thread`, MUST warn that every fire wakes that conversation and suggest `--thread` or `--session <name>`.
- `ravi triggers list` MUST mark an enabled trigger that has not fired for more than 30 days (counting from creation when it never fired) as dormant: `dormant: true` in JSON, `(dormant)` beside the fire count in text, and one warning with the count. A disabled trigger is never dormant.

## Reply account and channel

- A trigger whose frozen reply source carries a Slack thread id and whose reply session is that thread's open child is delivered into the thread: the runner builds the turn's source from the thread (chat, canonical chat id, timestamp), not from the session's last chat, which is the channel root (`channels/slack/threads`). A trigger turn replies where its reply session last talked, through the account that chat was reached through: the session's `lastAccountId`, the account in a session key, or the frozen reply source's. The trigger's own `accountId` replaces that account only under the two conditions below. One rule (`triggerSourceAccount`) covers every fire path and is applied to the outbound source last.
- The account MUST be a credential for the destination's channel. The channel of an account is the channel of the instance that goes by that name (`instances`), as Ravi names channels: `whatsapp-baileys` is `whatsapp`. An instance on another channel makes the account the wrong provider's credential: the runner MUST keep the account the destination carries and MUST NOT pair it with that chat. An account no instance goes by names no channel and is applied.
- The account MUST have been set on its own (`--account`, the agent's account). An account equal to `replySource.accountId` was taken from the creator's chat and says nothing about the chat the destination reaches, which can sit in another workspace of the same channel: it MUST NOT replace an account the destination already carries, and is used only when the destination carries none.
- The cases it exists for: a handed-off follow (`gh-follow`, `page-comment`) whose durable parent last talked on WhatsApp, or through another Slack account, than the thread that armed it; and a trigger whose account is a WhatsApp instance (`main`) replying in a session that last talked on Slack, where the reply was lost.

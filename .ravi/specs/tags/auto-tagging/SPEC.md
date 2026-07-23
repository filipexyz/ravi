---
id: tags/auto-tagging
title: "Auto-Tagging Rules"
kind: capability
domain: tags
capability: auto-tagging
capabilities:
  - auto-tagging
  - tag-classification
  - rule-engine
tags:
  - tags
  - rules
  - automation
  - contacts
  - chats
  - crm
applies_to:
  - src/tags
  - src/runtime
  - src/contacts.ts
  - src/router
  - src/cli/commands/tags.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Auto-Tagging Rules

## Intent

Auto-tagging rules are Ravi's deterministic classifier for operational assets.

A rule examines the current state of an asset and the assets reachable from it (contact ↔ chat ↔ account ↔ opportunity ↔ session ↔ task) and applies or removes canonical tags when its declared conditions match.

Auto-tagging MUST stay deterministic. The same asset state and rule definition MUST always produce the same tag set. Auto-tagging MUST NOT depend on model inference, freeform interpretation, or unordered evaluation.

This capability extends `tags` and complements:

- `contacts/identity-graph/inbound-contact-intake` (instance-level default tags on contact creation)
- `runtime/observation-plane/rules` (tag-driven observer attachment)

## Boundaries

- Auto-tagging MUST NOT change `contact_policies.status`, `crm_contact_profiles.lifecycle`, or any access policy directly. It MAY only mutate tag attachments.
- Auto-tagging MUST NOT grant permissions directly. If it applies a `policy.*`
  tag, that tag MUST NOT be consumed by permission policy unless the permission
  policy rule explicitly opts in to the auto-generated tag source or source
  rule id.
- Auto-tagging that writes `policy.*` tags MUST preserve canonical provenance
  for every asset type: `source=tag_rules:<rule-id>` or equivalent, plus
  metadata containing `ruleId`, rule version, evaluation cause, and target
  asset. If a target path cannot preserve that provenance, permission policy
  MUST reject that binding as untrusted.
- Auto-tagging MUST NOT mutate raw `chats`, `chat_messages`, `chat_participants`, or CRM source rows. It MAY only emit tag attachments and the corresponding audit events.
- Auto-tagging MUST NOT replace `contacts/identity-graph/inbound-contact-intake` default tags. Default tags fire at creation; auto-tagging fires on subsequent state.
- Auto-tagging MUST NOT replace observer rules. Observer rules consume tags; auto-tagging produces them.
- AI/LLM enrichment paths SHOULD propose facts through CRM, not invoke this engine. Auto-tagging is deterministic infrastructure, not an analysis surface.

The condition vocabulary defined in this spec is also the intended foundation for **composed observer rules** (rules that combine `has-tag`, `not-has-tag`, `has-any-tag`, `has-all-tags`, and reachable-asset predicates). When that work happens in `runtime/observation-plane/rules`, both engines MUST share the same condition vocabulary and the same parser; auto-tagging and observation MUST NOT drift into separate DSLs.

## Rule Model

A rule has the following shape:

```yaml
id: <stable-id>
description: <short purpose>
enabled: <bool, default true>
scope: <contact|chat|account|opportunity|session|task>
conditions:
  - <predicate>
  - <predicate>
  - ...
apply:
  - target: <contact|chat|account|opportunity|session|task>
    tag: <tag-slug>
    when: <"matched"|"not-matched">
    on-conflict: <"skip"|"replace-family">
    remove-tag: <tag-slug>           # optional explicit removal
priority: <int, default 0>
evaluation:
  reactive: <bool, default true>
  cron: <cron-expression|null>
metadata:
  owner: <agent-or-team>
  reason: <free text reason for audit>
```

Rules MUST be declarative. Behavior MUST be derivable from the stored rule definition and the targeted asset state alone.

Rule storage SHOULD live in `.ravi/tag-rules/*.yml` for version-controlled rules and MAY also live in a DB-backed registry for runtime-edited rules. When both sources exist, conflict resolution MUST be explicit; the engine MUST NOT silently merge.

Rule ids MUST be globally unique within the registry namespace.

### Evaluation Order

Rules MUST be evaluated in a deterministic order so that the same input state and the same rule set produce the same final tag state on every run.

Order:

1. Rules are sorted by `priority` ascending. Lower numeric priority runs first.
2. Ties on `priority` are broken by rule `id` ascending (lexicographic).
3. The engine MUST NOT depend on database read order, file scan order, or insertion timestamps for ordering.

Conflicting applies within the same evaluation pass (e.g., one rule adds tag X, another removes it) MUST be resolved by the same order. The last-applied action wins, and the engine MUST log the conflict so operators can detect unintended overlap.

## Conditions Vocabulary

Conditions are typed by `scope`. The engine MUST reject rules whose conditions reference predicates not defined for the chosen scope. The engine MAY provide cross-domain predicates by name (`has-chat-with`, `has-contact-with-tag`, etc.) that traverse the asset graph.

### `scope: contact`

- `has-tag`, `not-has-tag`, `has-any-tag`, `has-all-tags`
- `status`: equals one of `allowed | pending | blocked | discovered`
- `kind`: equals `person | org`
- `primary-phone-present`, `primary-email-present`
- `last-inbound-age`, `last-outbound-age`, `created-age`: duration operators (`> 7d`, `<= 24h`, ...)
- `has-chat-with`: nested condition block evaluated against a related `chat`
- `has-account-with`: nested condition block evaluated against the linked `account`
- `has-opportunity-with`: nested condition block evaluated against any linked `opportunity`
- `has-session-with`: nested condition block evaluated against any session with the contact as participant

### `scope: chat`

- `chat-type`: equals one of `dm | group | channel | thread`
- `channel`, `instance-id`
- `message-count`: numeric operators
- `any-message-text-matches`, `last-n-messages-text-matches`: regex/keyword predicate with optional `from`, `since`, `n`
- `has-media`: equals `audio | image | video | document | any`
- `last-inbound-age`, `last-outbound-age`
- `has-participant`: nested condition against `chat_participants`
- `has-contact-with`: nested condition against the chat's contact participants
- `has-tag`, `not-has-tag`, `has-any-tag`, `has-all-tags`

### `scope: account`

- `lifecycle`, `health`
- `has-tag`, `not-has-tag`, etc.
- `has-contact-with`, `has-opportunity-with`

### `scope: opportunity`

- `status`, `stage`
- `value-range`
- `age`, `last-touch-age`
- `has-contact-with`, `has-task-pending`
- `has-tag`, etc.

### `scope: session`

- `agent-id`
- `last-turn-status`
- `age`, `last-event-age`
- `has-contact-with` (via `session_participants` owner_type=`contact`)
- `has-tag`, etc.

### `scope: task`

- `status`, `profile-id`
- `due-age`, `created-age`
- `has-contact-with`
- `has-tag`, etc.

Cross-domain predicates MUST resolve relationships through canonical tables. The engine MUST document each predicate's resolution path so audits can explain "why did this rule match?".

## Apply Semantics

Each `apply` entry MUST resolve to a concrete tag binding action:

- `when: matched` (default): the action runs when conditions hold true.
- `when: not-matched`: the action runs when conditions DO NOT hold. Useful pairs are `apply tag X when matched` and `apply remove-tag X when not-matched` to keep the tag in sync with the underlying state.
- `target`: MUST be the same scope as the rule OR a reachable related asset declared via the conditions (e.g. `has-chat-with` makes chat addressable as `target: chat`).
- `target-mode`: MUST be declared whenever the reachable target is plural (e.g. `scope: chat → target: contact` in a group chat, or `scope: contact → target: chat` for a contact with several chats). Allowed values in MVP:
  - `all`: apply the action to every reachable instance of the target.
  - `matched`: apply only to instances that satisfied a nested `has-<target>-with` sub-condition. The engine MUST refuse rules using `matched` without a corresponding nested sub-condition that produced a candidate set.
  Additional modes (e.g. `sender`, `primary`) MAY be added later when concrete cases require them; the engine MUST refuse unknown modes.
  When the reachable target is unambiguous (single instance), `target-mode` MAY be omitted and the engine MUST behave as if `all` was set.
- `tag`: canonical slug. The slug MUST be normalized through the canonical tag pipeline before storage.
- `remove-tag`: explicit slug or slug list to detach in addition to the apply. Use this to express simple state transitions (e.g. moving a contact from `lifecycle:triage` to `lifecycle:qualified`) without introducing a separate family system. Tag families MAY be added in a future revision once duplication patterns make manual `remove-tag` painful; until then, transitions MUST be explicit in the rule definition.

Every apply that mutates tag state MUST emit:

- a `canonical_tag_bindings` insert/delete (already covered by existing tag pipeline).
- a `profile.tag_added` or `profile.tag_removed` event in the target's timeline (`contact_events` for contacts; analogous tables for other domains).
- the rule id, evaluation cause, and asset snapshot in the event evidence so audits can answer "why did this tag appear/disappear?".

Repeated evaluations MUST NOT emit duplicate `tag_added`/`tag_removed` events when the underlying state did not change. The engine MUST short-circuit no-op transitions.

## Execution Model

Auto-tagging runs in two complementary modes. Both MUST share the same rule registry and the same condition evaluation code.

### Reactive

Reactive evaluation MUST fire on events that can change an asset's match state:

- `message.received` and `message.outbound` for chats and the contact participants of those chats.
- `tag.added`/`tag.removed` on any asset for rules that depend on `has-tag`/`has-any-tag`/`has-all-tags`.
- `contact.created`, `contact.updated`, `contact.policy.changed`.
- `chat.created`, `chat.updated`, `chat.participant.changed`.
- `crm.opportunity.changed`, `crm.task.changed`, `crm.account.changed`.
- `session.participant.changed` for session-scoped rules.

Reactive runs MUST be scoped to rules whose conditions can be affected by the event. The engine MUST maintain an event→rule dependency map computed from the rule definitions; full re-evaluation of every rule on every event is forbidden.

Reactive runs MUST NOT block the originating event path. The engine SHOULD run as an async consumer.

### Periodic

Periodic evaluation MUST cover rules whose conditions are time-based and therefore cannot be triggered by a discrete event:

- `last-inbound-age`, `last-outbound-age`, `created-age`, `age`, `due-age`.
- `cron`-specified evaluations on the rule itself.

Periodic runs MUST iterate only the assets potentially affected (delta-aware): the engine MUST persist a per-rule cursor (latest evaluated `provider_timestamp` or `updated_at`) and process only assets newer than the cursor for rules whose conditions are monotonic in time.

For rules with non-monotonic time conditions (e.g. "older than 7d") the engine MUST evaluate the candidate set produced by SQL filters using indexed columns. Full table scans are forbidden in the periodic loop.

### Manual

Operators MUST be able to force-evaluate a specific rule against a specific asset id via CLI for debugging:

```bash
ravi tag-rules evaluate <rule-id> --target <type:id> [--apply|--dry-run]
```

Manual evaluations default to dry-run.

## Performance

The engine MUST scale to:

- thousands of contacts per instance;
- tens of thousands of chat messages per day per instance;
- dozens of active rules.

Design constraints:

- Condition evaluation MUST use prepared SQL statements against existing indexes.
- The engine MUST maintain the event→rule dependency map in memory; lookups MUST be O(1) by event type.
- Reactive evaluation MUST be bounded by the rules subscribed to the specific event family.
- Periodic evaluation MUST advance per-rule cursors only when the rule successfully completes its batch.
- Tag-change cascades MUST be flattened: a `tag.added` that triggers another `apply` that emits `tag.added` MUST NOT loop. The engine MUST detect cycles using rule id + target id + tag slug visited set per evaluation pass.

The engine MAY use additional indexes on `canonical_tag_bindings(asset_type, asset_id, tag_slug)` and `chat_messages(chat_id, provider_timestamp)` to support common predicates.

### Cascade Handling

Applying a tag MAY make another rule's conditions become true and trigger a further apply. The engine MUST guarantee that cascades terminate:

- **Cycle guard (required)**: each evaluation pass maintains a visited set of `(rule_id, target_type, target_id, tag_slug)` tuples. Re-entering the same tuple within the same pass MUST short-circuit without raising. The engine MUST log a `cascade.cycle_skipped` audit event when this happens so the operator can detect mis-designed rule loops.
- **Telemetry (required)**: every apply MUST log a `cascade.depth` value alongside the audit event, where depth 0 means the apply was triggered by the originating user/external event, depth 1 means it was triggered by another rule's apply at depth 0, and so on. This data is required so operators can later evaluate whether to introduce an explicit `max-depth` ceiling.
- **`max-depth` ceiling (deferred)**: an explicit blast-radius limit MAY be introduced in a later revision once cascade depth telemetry shows real chains. Until then, only the cycle guard protects against runaway cascades.

## Audit and Observability

- Every applied/removed tag MUST appear in the target's timeline event log with the rule id, condition snapshot, and cause (reactive/periodic/manual).
- `ravi tag-rules list/show` MUST expose each rule with `last-evaluated-at`, `last-match-count`, and `last-error`.
- `ravi tag-rules explain --target <type:id>` MUST list which rules currently match the target and why, mirroring `ravi observers rules explain`.
- `ravi tag-rules dry-run` MUST print the diff (would-add, would-remove, would-skip) without persisting changes.
- The engine MUST emit a NATS event `tag.rule.applied` for each non-trivial apply so external consumers can react.

## CLI Surface

The implementation SHOULD expose:

```bash
ravi tag-rules list
ravi tag-rules show <rule-id>
ravi tag-rules add <rule-id>            # from stdin/file
ravi tag-rules enable <rule-id>
ravi tag-rules disable <rule-id>
ravi tag-rules evaluate <rule-id> --target <type:id> [--apply|--dry-run]
ravi tag-rules explain --target <type:id>
ravi tag-rules validate
ravi tag-rules sync                     # rebuild rule registry from .ravi/tag-rules
```

`validate` MUST detect: unknown predicates for scope, unknown tag slugs, duplicate rule ids, conflicting apply targets, dependency cycles.

## Lifecycle

- Adding a rule MUST NOT retroactively apply tags. The rule fires on the next reactive event or the next periodic cycle.
- Disabling a rule MUST stop new apply actions. Existing tags applied by that rule MUST NOT be removed automatically; operators MAY use `ravi tag-rules remove-applied <rule-id>` to clean up if needed.
- Deleting a rule MUST be allowed only when the rule has produced no apply events in the audit log, or when the operator passes an explicit `--force` flag. Deletion MUST keep the audit events intact.
- Editing a rule's conditions or apply targets MUST bump a rule version; audit events MUST reference the rule version at the moment of evaluation.

## Invariants

- Determinism: same input state + same rule definition → same tag set.
- Conditions MUST be typed by scope. The engine MUST refuse rules with conditions outside the scope's vocabulary.
- Apply targets MUST be reachable from the scope via the conditions. Tagging unrelated assets is forbidden.
- No silent transitions: state changes MUST be expressed by explicit `remove-tag` (or, in a future revision, by tag families when promoted out of "deferred" status).
- No infinite cascades: each evaluation pass MUST short-circuit re-entry via the cycle guard and MUST log `cascade.depth` on every apply.
- All apply/remove actions MUST emit timeline events with provenance.
- Auto-tagging MUST NOT touch access policy, lifecycle, or runtime routing directly.
- Plural targets MUST be addressed via explicit `target-mode`. The engine MUST refuse rules with ambiguous reachability.

## Validation

- `bun test src/runtime/tag-rule-engine.test.ts`
- `bun test src/cli/commands/tag-rules.test.ts`
- `bun run typecheck`
- `bun run build`

Operator validation:

```bash
ravi tag-rules validate
ravi tag-rules dry-run --rule <id> --target <type:id>
ravi tag-rules explain --target <type:id>
```

## Acceptance Criteria

- A rule with `scope: chat`, `any-message-text-matches: "(comprar|preço)"`, and `apply target: contact tag: intent:purchase` tags the contact within seconds of the matching message arriving.
- A rule with `scope: contact`, `last-inbound-age: "> 7d"`, runs only via periodic mode and tags the contact `temperature:cold` on the next cycle that crosses the threshold.
- Disabling a rule stops future apply actions while preserving past audit history.
- Repeated reactive evaluations of the same state do not emit duplicate timeline events.
- The engine refuses a rule whose condition `chat-type: dm` is declared under `scope: contact` without `has-chat-with`.
- `ravi tag-rules explain` shows which rule caused a tag and the condition snapshot used.
- A rule that loops (tag A triggers apply that re-triggers itself) is detected and reported by the cycle guard rather than crashing the engine.

## Known Failure Modes

- **Invisible classification**: a rule silently tags contacts without timeline audit, making the change unexplainable.
- **Cascade storm**: a rule applied tag triggers another rule that re-applies the first, causing infinite re-evaluation.
- **Mis-scoped predicate**: a rule uses a chat-only predicate at contact scope and fails or, worse, matches incorrectly.
- **Stale cursor**: periodic cursor advances despite incomplete batch, leaving assets permanently un-evaluated.
- **Conflicting families**: two rules apply different slugs from the same exclusive family with no priority resolution.
- **Surprising retroactivity**: adding a rule retroactively re-tags historic assets, surprising operators expecting forward-only behavior.
- **Performance regression**: a rule uses a predicate that bypasses indexes and triggers full-table scans on every event.
- **Behavior leakage**: auto-tagging changes policy state (status/lifecycle) instead of just tags, violating the boundary with `contacts/identity-graph` and `contacts/crm`.

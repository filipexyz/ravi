# Contact Timeline Checks

## Static Checks

- Contact mutation code should call a shared event writer.
- Contact timeline reads should resolve through canonical `contact_id`.
- Contact timeline writes should include `scope_type` and `scope_id`, defaulting to `global` only for globally true facts.
- New contact event payloads should include source, actor, confidence, and evidence.
- Agent-generated context should use proposed/attributed event types unless explicitly confirmed.
- Group-specific labels should not be written as global contact tags.
- NATS contact event consumers should not rely on raw Omni ids as contact identity.

Suggested scans:

```bash
rg -n "UPDATE contacts|INSERT INTO contacts|addContactTag|removeContactTag|setOptOut|mergeContacts|linkContactIdentity|unlinkContactIdentity" src
rg -n "contact_events|scope_type|scope_id|ravi\\.contacts\\.|context\\.fact|profile\\.metadata|policy\\.status" src .ravi/specs
```

## Runtime Tests

### Tag Timeline

Given:

- a known contact

When:

- `ravi contacts tag <contact> vip`

Expected:

- current tags include `vip`
- a `profile.tag_added` event exists for the contact
- event scope is global only if `vip` is intended as a global contact segment
- event evidence identifies the CLI/API source

### Metadata Timeline

Given:

- a known contact

When:

- metadata is set or removed

Expected:

- current metadata projection changes
- scoped metadata keeps `scope_type` and `scope_id`
- a timeline event records key, old value when available, new value, actor, and source

### Scoped Context

Given:

- the same contact is a CRM lead and a project stakeholder

When:

- both statuses are recorded

Expected:

- CRM lifecycle is stored under `scope_type=domain`, `scope_id=crm`
- project role is stored under `scope_type=project`, `scope_id=<project>`
- neither value overwrites `contact_policies.status`

### Policy Timeline

Given:

- a pending contact

When:

- the contact is approved, blocked, opted out, or allowed agents change

Expected:

- `contact_policies` current state changes
- a `policy.*` event records the change
- identity/platform records do not change unless explicitly requested

### Agent Proposal

Given:

- an agent observes messages from a contact

When:

- the agent infers a possible fact

Expected:

- a `context.fact_proposed` event is written
- confirmed profile metadata is not overwritten automatically
- confidence and evidence are present

### Merge History

Given:

- contact A and contact B both have timeline entries

When:

- A is merged into B

Expected:

- merge audit/timeline event records source and target
- B timeline queries can include A history
- original event provenance remains inspectable

### Scoped Subscription

Given:

- an agent subscribed to contact X

When:

- contact Y gets a timeline event

Expected:

- the agent does not receive Y's private timeline unless it has explicit permission or a broader approved scope

### Scoped Timeline Mutation

Given:

- a bounded contact update in a chat context

When:

- a `profile.tag_added` event is persisted with `scope_type=chat` and a valid `scope_id`

Expected:

- the event payload keeps `scope_type` and `scope_id`
- replayed scoped queries filter by the same scope
- global queries can include it only through explicit global-projection semantics

## Acceptance Gate

Implementation is not complete until:

- every current-state mutation has corresponding timeline provenance
- timeline query works by contact id and by linked identity ref
- timeline query can filter by scope
- contact events can be replayed or re-emitted to NATS
- agent-written context is attributed and confidence-scored
- permissions are enforced for timeline reads/subscriptions
- merge/unlink operations preserve explainability

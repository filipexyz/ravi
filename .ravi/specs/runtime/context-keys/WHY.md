# Runtime Context Keys Rationale

## Decision

Active provider dispatch issues invocation-scoped `turn-runtime` credentials
with `authorityMode=agent-identity`. The executor agent acts through a
compartment-scoped agent identity, and each turn receives its own auditable
snapshot.

## Why Agent Identity

The previous delegated/intersection model made common operation depend on the
agent, contact, chat, and surface all carrying matching capabilities. That was
secure but too difficult to operate: a valid agent workflow could fail because
the chat had zero capabilities, and agents had to tell operators to grant long
lists of raw command ids.

Agent identity moves durable tool authority to the executor agent profile and
projects it into a compartment such as workspace, chat, DM, or automation.
Contacts and chats remain provenance, interaction policy, and compartment
selectors unless a future overlay provider explicitly constrains them.

## Capability Drift

Capabilities are snapshotted at turn issuance for audit. A grant added after a
denial must be visible on the next turn, and a revoke must stop authorizing by
the next authority check. Long-lived root contexts are not the source of truth.

To force a new snapshot, start a new turn or reset/revoke the session runtime
contexts. The next dispatch creates a fresh agent-identity `turn-runtime`
context.

## Metadata Drift

Runtime metadata can change turn to turn: model override, effort, thinking,
provider, source, approval source, actor resolution, and compartment. The
turn-scoped context records the metadata that was true when that invocation was
created.

## Lifecycle

Session reset and runtime abort are explicit lifecycle boundaries for revoking
live runtime contexts. Cleanup of historical `agent-runtime` records is an
operator action, not a daemon side effect.

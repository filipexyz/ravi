# Runtime Providers Rationale

## Why Providers Are Adapters

The runtime host already solves the hard Ravi-specific problems: message queueing, task barriers, session trace, permissions, response delivery, provider state persistence, and recovery. If providers own any of those concerns, each new engine creates another partial runtime.

The provider contract keeps new engines cheap to add and safer to debug.

## Why Capabilities Instead Of Provider Branches

Provider IDs are implementation details. Capabilities are behavior.

Branching on provider ID makes the third provider expensive because every existing branch has to be audited. Branching on capabilities lets the host ask precise questions:

- Can this provider resume?
- Can it fork?
- Can it receive host hooks?
- Can it call dynamic tools?
- Can it expose runtime controls?
- Can it safely run restricted agents?

## Why Raw Events Are Not Source Of Truth

Raw events are useful for observability and regression capture, but each provider has different shapes and stability guarantees. Canonical events are the only durable contract between provider adapters and Ravi host runtime.

## Why Tool Policy Belongs To Ravi

Tool authorization has session scope, agent permissions, command parsing, dangerous pattern blocking, approval routing, and audit. Providers may expose hook points or tool-call callbacks, but they must delegate the decision to Ravi.

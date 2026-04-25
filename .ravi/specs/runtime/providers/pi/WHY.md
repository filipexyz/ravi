# Pi Provider Rationale

## Why Pi Is A Runtime Provider

Pi runs coding-agent sessions. Ravi already has agent identity, routing, sessions, tasks, traces, contacts, and channel delivery. Treating Pi as a Ravi agent would duplicate concepts and blur ownership.

The clean boundary is:

- Ravi agent/session decides what should run.
- Runtime provider executes the turn.
- Ravi host event loop normalizes results, persistence, delivery, traces, and policy.

## Why RPC First

RPC JSONL gives Ravi a narrow operational boundary:

- Easy to launch and kill.
- Easy to fixture in tests.
- Native Pi commands already cover prompting, steering, aborting, model switch, thinking level, compaction, session state, and message reads.
- Pi internals can evolve without Ravi importing deep package internals on day one.

The cost is extra process management and less direct control over tools. That tradeoff is acceptable for the first E2E.

## Why Not Bridge Tools First

Pi has its own tools and can execute them in parallel. Ravi has its own permission model and currently tracks one active tool in the host event loop.

Bridging tools before the provider contract is hardened would create a confusing hybrid:

- Some tools would obey Ravi policy.
- Some tools would obey Pi internals.
- Tool events could race the current Ravi tracking model.

The MVP should declare full Pi tool ownership and block restricted Ravi agents. Tool bridging belongs in the SDK phase.

## Why The Spec Forces Capability Work

Pi exposes differences that the current provider matrix does not model well: subprocess RPC, file-backed sessions, provider-native compaction, parallel tools, native controls, and final assistant-message usage.

Those should be expressed as capabilities, not provider-specific branches.

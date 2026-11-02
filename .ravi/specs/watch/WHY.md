# Watch / WHY

## Why Watch Is Top-Level

Watch is a product primitive, not an inbox subcommand. Operators think in terms
of "watch this package/repo/source and tell this group when something happens".

Inbox is transport. It should not own connector creation or trigger ergonomics.

## Why Normalize Events

Npm, GitHub, and future providers have different webhook and polling shapes.
Triggers need a stable subject and payload contract so users can create one
mental model for "event happened" regardless of provider or placement.

## Why Support Local And Console Placement

Some sources are cheap and safe to poll locally. Others require webhooks,
managed OAuth/apps, long uptime, or credentials that should live in Console.

Placement should be an implementation detail of the watch. Trigger behavior
should not change when a watch moves from local to Console.

## Why Reuse Triggers

Ravi already has durable NATS-backed triggers with chat reply capture,
cooldowns, filters, and isolated/main session behavior. Watches should feed that
system instead of creating a parallel automation runtime.

## Why API Publication Is Explicit And Ready

The Git Data API publication path does not necessarily execute `gh pr create`
through a Ravi command approval hook. Observing that command cannot establish
ownership of every PR. The publication finalizer calls the existing follow
primitive directly and reports success only after the producer and subscription
exist. Re-running is also the reconciliation path for already published PRs.

Publishing ready is smaller than introducing a second state machine that waits
for every non-review check and then promotes a draft. The Review Gate already
requires independent approval on the current head; ready does not grant it.

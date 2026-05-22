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

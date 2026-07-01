# Channels / WHY

## Problem

Ravi needs to abstract transport delivery from runtime decisions. Without a clear boundary, product code drifts into transport-specific conditionals, agent-facing APIs expose raw provider identifiers, and operational behavior (routing, presence, notifications) becomes entangled with delivery mechanics.

## Decision

Define a `channels` domain that owns the boundary between Ravi runtime and transport adapters. Ravi owns operational behavior; transport adapters only deliver payloads and report state. Channel-specific behavior is exposed through typed capabilities and normalized events, not provider conditionals.

## Tradeoff

Adding an abstraction layer between Ravi and Omni introduces indirection. This is intentional: the indirection is the boundary that prevents product code from depending on transport internals.

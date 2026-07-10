# Permissions Rationale

## Why This Exists

Ravi runs many principals — agents, agent identities, contacts, chats,
sessions, automations, and system actors — across shared surfaces. Without a
single canonical authorization model, each surface and provider would grow its
own ad-hoc access rules, and authority would leak across compartments.

Permissions centralize that decision: Ravi resolves canonical subjects and
objects, fails closed on anything unresolved, and materializes effective
authority through registered providers instead of a parallel native graph.

## Design Position

- Authorization is a Ravi-owned product concern; providers request decisions,
  they do not own policy.
- Discovery is disclosure: listing, search, and autocomplete are filtered to
  what the effective context may see.
- Recurring authority attaches to the agent identity / executor agent through
  provider-owned config, not a shared grants table.
- `full-access` is break-glass, never the normal next step.

## Safety Versus Authorization

Capability authorization answers "is this principal allowed to do X". It is not
the last line of defense. Shell hard-safety (`runtime/shell-safety`) is a
separate policy layer that denies dangerous shell patterns and every
`UNCONDITIONAL_BLOCKS` executable regardless of how much authority a principal
holds — including `execute executable:*`, `admin system:*`, and `full-access`.

An "always blocked" promise cannot have hidden exceptions. A hard-safety denial
is a policy decision, not a missing grant, so it never materializes a
capability, creates a resolvable `permission_denials` row, or recommends a
permission/profile/full-access remediation.

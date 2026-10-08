---
id: pages/app-gateway
title: "Why the app gateway installation side is transport plus local opt-in"
kind: capability
domain: pages
capability: app-gateway
status: draft
---

# Why the installation side is transport plus local opt-in

Console already decides who can view a Pages site and mint a viewer assertion for it. Repeating that policy in OSS would create a second registry that drifts. So the installation only verifies the public formats (grant, assertion, ticket) on the Console JWKS and then applies the one thing Console cannot know: what the operator of this machine agreed to run.

The local opt-in has three layers on purpose. `apps.gateway.allowed_operations` is the operator's list. The manifest `gateway` declaration is the app author's statement of which argv a viewer may pass, because `"mutating": false` says nothing about argv safety. `apps.gateway.require_link` and the app's Permission Provider decide per viewer. Each layer can only narrow.

The relay is dial-out so the installation opens no port. One socket per installation is kept by a SQLite lease, and a 4000 close is read against the sockets this runner opened, so a renewal never looks like a competing process.

A gateway invoke runs under a runtime context without an agent. Before this feature a missing `agentId` meant "local operator", which would have given every viewer invoke full local authority. The fallback now applies only when there is no context record at all.

## Rejected

- An inbound listener on the installation. The relay keeps the machine closed to the network.
- A Ravi Link lookup through Console during an invoke. It would put Console back on the per-invoke path.
- Wildcards or app-only entries in `apps.gateway.allowed_operations`. Each exposed operation is a deliberate choice.
- Treating `"mutating": false` as enough to expose an operation.
- Registering targets inside `ravi pages assertion audiences`. One `(site, aud)` belongs to one registry.

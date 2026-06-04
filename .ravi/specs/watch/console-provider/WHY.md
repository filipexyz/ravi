# Console Provider Watches / WHY

## Why Console Owns Webhooks

Provider webhooks need public ingress, signing secrets, provider app private
keys, installation access tokens, idempotent retry handling, and always-on
availability. Those are Console responsibilities, not local OSS runtime
responsibilities.

## Why GitHub App Instead Of Local Tokens

The Ravi GitHub App gives a clean provider boundary: installations are selected
per org/user/repository set, permissions can be scoped by event family, and
private repos can be watched without persisting personal access tokens locally.

## Why Console Delivery

Console delivery is the local bridge for Console-produced events. It lets local
Ravi receive remote watch events without exposing local HTTP servers or provider
webhook secrets.

The historical `ravi inbox` command name is a compatibility alias. Product
inbox semantics belong to `inbox/SPEC.md`.

## Why Keep Trigger Topics Local

Users create triggers against `ravi.watch...` subjects. Keeping those subjects
stable means a watch can move between local polling and Console webhooks without
rewriting group triggers.

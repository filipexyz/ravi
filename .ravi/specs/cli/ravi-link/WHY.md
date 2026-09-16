---
id: cli/ravi-link
title: "Why ravi link is ambient"
---

# ravi link / WHY

## Why Zero Flags

If `ravi link` accepted `--contact` or `--user`, an agent (or a confused
operator) could bind the wrong human to the wrong Console account. The
product agreement is: the current cloud session is the Console identity, and
the current turn's resolved contact is the local identity. No substitution.

## Why Login Must Come First

The binding is a Console record. Without `ravi login` there is no
`consoleUserId`, `orgId`, or installation to write. Local-only linking would
invent an identity Console cannot enforce.

## Why Not RAVI_ADMIN_TOKEN

Admin/operator tokens represent the host, not the human in the chat.
Using them for SSO or connector pass-through would let one operator act as
every linked user.

## Why Cache IDs Locally

Later turns need `consoleUserId` on metadata without a Console round trip on
every message. A signed/TTL cache of IDs is enough. Tokens stay in the
per-user cloud-auth slot. Console remains the source of truth.

## Follow-ups

- Installation enrollment org split: require session org == enrolled org.
- Full user-scoped connector vault on the `link.ravi.so` Worker.
- Live e2e against merged Console actor-binding routes.

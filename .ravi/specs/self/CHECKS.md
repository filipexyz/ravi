---
id: self/checks
title: "Ravi Self Checks"
kind: domain
domain: self
status: draft
normative: false
---

## Context Resolution

- `ravi self whoami` works with a resolved CLI context from runtime key,
  default credential, tool or gateway.
- Missing/unresolvable context fails with a public typed cause.
- No current SELF command accepts a cross-session or cross-agent selector.
- Revoked/expired contexts are reported as unavailable.

## Chat and Omni Boundary

- A WhatsApp group appears as `chat`, not `contact`.
- Raw JIDs/LIDs appear only under provenance/debug.
- A DM exposes primary contact convenience without hiding actor metadata.
- A session bound to the same chat as another agent does not claim exclusive chat ownership.

## Output Bounds

- `ravi self recent` defaults to a small limit.
- `ravi self context` does not dump full transcripts.
- JSON output includes a typed `status`/`reason` on each degradable section
  and top-level `nextReads`.
- Human output is compact enough for agent prompts.
- Unknown `--fields` fails with `USAGE_ERROR` and accepted fields.
- Actor, Chat and Route appear once each in human context output.

## Permissions

- `ravi self permissions` summarizes capabilities without printing context keys.
- Authorization failures use the public error envelope and are never disguised
  as an omitted section.
- Any future cross-session lookup must be permission-checked and audited before
  shipping.
- Root help and SELF use the same registered capability facts; a missing
  context reports capabilities unavailable rather than empty.

## Environment and schemas

- Group help and `explain` list actor env names and precedence without values.
- Env-derived actors are `partial`, `source: environment`, `trust: unverified`.
- All eight return schemas are concrete and pass the return-schema quality gate.

## Zero effects

- Every command declares read access/effect class `none`.
- Runtime context resolution uses `touch: false, readOnly: true`.
- SELF source imports no DB/NATS write operation.

## Knowledge Integration

- `ravi self knowledge` works when Knowledge exists.
- `ravi self knowledge` degrades clearly when Knowledge has no matching thread.
- Knowledge summaries include evidence/confidence hints when available.

## Route Debugging

- `ravi self route` explains why the current agent/session was selected.
- Route output distinguishes route match, fallback, and manual binding.
- Route output uses canonical chat/session/agent ids.

## Security addendum checks

- Inline tool/gateway context is confirmed against the trusted registry with a
  read-only, no-touch lookup before SELF returns data.
- Unknown, expired, revoked and materially altered contexts fail with distinct
  public codes.
- Existing session, binding, chat, route and runtime facts agree with the same
  registered agent. Contradictions fail as `SELF_AUTHORITY_DIVERGENT` without
  exposing the foreign record or working directory.

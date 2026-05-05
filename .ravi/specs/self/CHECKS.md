---
id: self/checks
title: "Ravi Self Checks"
kind: domain
domain: self
status: draft
normative: false
---

# Ravi Self Checks

## Context Resolution

- `ravi self whoami` works inside a live runtime with `RAVI_CONTEXT_KEY`.
- `ravi self whoami` fails clearly outside Ravi context.
- `ravi self context --session other` requires permission.
- Revoked/expired contexts are reported as unavailable.

## Chat and Omni Boundary

- A WhatsApp group appears as `chat`, not `contact`.
- Raw JIDs/LIDs appear only under provenance/debug.
- A DM exposes primary contact convenience without hiding actor metadata.
- A session bound to the same chat as another agent does not claim exclusive chat ownership.

## Output Bounds

- `ravi self recent` defaults to a small limit.
- `ravi self context` does not dump full transcripts.
- JSON output includes `missing`, `unauthorized`, and `nextReads`.
- Human output is compact enough for agent prompts.

## Permissions

- `ravi self permissions` summarizes capabilities without printing context keys.
- Unauthorized sections are omitted or redacted with explanation.
- Cross-session lookup is audited.

## Knowledge Integration

- `ravi self knowledge` works when Knowledge exists.
- `ravi self knowledge` degrades clearly when Knowledge has no matching thread.
- Knowledge summaries include evidence/confidence hints when available.

## Route Debugging

- `ravi self route` explains why the current agent/session was selected.
- Route output distinguishes route match, fallback, and manual binding.
- Route output uses canonical chat/session/agent ids.

# Artifacts / WHY

## Rationale

The image-generation incident on 2026-04-26 exposed a structural gap:
`ravi image generate --source ...` could stay blocked for minutes while the agent
had no durable object to monitor. A successful alternate generation produced a
file outside the Ravi artifact ledger and had to be registered manually.

The better model is to create the artifact first and let generation update it
over time. This turns artifacts into live handles for async work, not just final
records.

## Decisions

- Treat artifacts as lifecycle objects with status and event history.
- Use artifacts as the natural progress handle for generated files, media,
  reports, exports, transcriptions, and other long-running outputs.
- Keep tasks and artifacts distinct:
  - Tasks represent work to be done.
  - Artifacts represent the output being produced.
  - Artifact events explain the output lifecycle.
- Prefer an `artifact_events` timeline over stuffing progress into artifact
  metadata. Metadata is final-state context; events are operational history.
- Notify the requesting session when an artifact reaches `completed` or `failed`,
  mirroring the way task progress can inform sessions.

## Rejected Alternatives

- Waiting synchronously until provider completion for all media generation.
  This blocks the agent and gives no reliable progress object.
- Registering artifacts only after the file exists.
  This loses queue/provider/failure history and cannot support progress.
- Using tasks as the only progress primitive.
  Many outputs are not tasks from the user's point of view; the artifact itself
  is the object the user wants to follow.

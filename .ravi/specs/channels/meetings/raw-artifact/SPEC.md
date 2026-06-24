---
id: channels/meetings/raw-artifact
title: Meeting Raw Artifact
kind: feature
domain: channels
capability: meetings
feature: raw-artifact
tags:
  - meetings
  - artifacts
  - transcript
  - lineage
  - events
applies_to:
  - src/artifacts/
  - src/channels/
  - src/omni/session-stream.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Meeting Raw Artifact

## Intent

`meet.md` is the raw, durable handoff artifact for a Ravi meeting session.

It gives the consuming agent complete meeting context without forcing the meeting runtime to summarize, interpret, prioritize, or decide next actions.

## Artifact Contract

The P0 artifact MUST be Markdown named `meet.md` unless a package contains multiple files and references it as the primary artifact.

The artifact MUST be raw:

- no AI summary;
- no inferred decisions;
- no generated task list;
- no backlog interpretation;
- no cleaned-up paraphrase replacing the transcript.

The artifact MAY include mechanical headings and formatting as long as they do not change the meaning of the captured meeting material.

## Required Sections

`meet.md` MUST include:

1. Metadata
   - title or provider meeting id;
   - provider;
   - meeting URL or provider reference when available;
   - start/end timestamps or equivalent date/duration;
   - origin session/agent references when available.
2. Participants
   - detected participants when available;
   - unresolved/unknown participants when speaker identity is incomplete;
   - Ravi agent participant identity.
3. Transcript
   - all captured transcript segments;
   - speaker per segment when available;
   - timestamp per segment when available;
   - provenance marker when segments come from captions, realtime, audio transcription, or imported transcript.
4. Media References
   - recording refs when available;
   - audio refs when available;
   - video refs when available;
   - diagnostic/log refs when available.
5. Capture Diagnostics
   - provider failures or partial-capture notes;
   - missing fields that affect transcript fidelity.

## Suggested Markdown Shape

```md
# Meet

## Metadata

- Title:
- Provider:
- Meeting ID:
- URL:
- Started at:
- Ended at:
- Duration:
- Origin session:
- Origin agent:

## Participants

- <speaker-or-participant>

## Transcript

### <timestamp> - <speaker>

<raw text>

## Media References

- <kind>: <path-or-uri>

## Capture Diagnostics

- <raw diagnostic note>
```

The renderer MAY choose a denser transcript format when the segment count is high, but it MUST preserve speaker/timestamp/provenance fields.

## Artifact Ledger

The generated `meet.md` MUST be registered in the Ravi artifact ledger.

Artifact input SHOULD include:

- `kind`: `meeting.raw` or `meeting.transcript.raw`;
- `title`: meeting title or provider id;
- `status`: `completed` on successful render;
- `filePath` or `blobPath`;
- `mimeType`: `text/markdown`;
- `sessionKey` and/or `sessionName` for the origin session;
- `agentId` for the origin agent when known;
- `channel`, `accountId`, `chatId`, and `messageId` when the meeting was requested from a channel;
- `metadata` with provider, meeting id, timestamps, participant count, segment count, and media refs;
- `lineage` linking source capture files and provider run ids.

Artifact lifecycle events MUST be appended for meaningful transitions. At minimum, the generator SHOULD produce `created` and `completed`, or `failed` when rendering fails.

## Meeting Events

After artifact creation, Ravi SHOULD emit `ravi.meetings.artifact_generated` with artifact id and meeting metadata.

The artifact ledger will also emit the generic artifact lifecycle topics. Consumers that need meeting semantics SHOULD use meeting events; consumers that only need generic artifact status MAY use artifact lifecycle events.

## Session Handoff

The origin session MUST receive a post-meeting context message containing the artifact id/path and metadata required to continue work.

The message MUST tell the consumer that the artifact is raw meeting material. It MUST NOT contain a generated summary or analysis.

Recommended handoff text:

```text
[System] Inform: Meeting raw artifact generated.

Artifact: <artifact-id>
Path: <meet-md-path>
Provider: <provider>
Meeting: <title-or-id>
Started: <timestamp>
Ended: <timestamp>

Use the artifact as the raw source of truth for post-meeting work.
```

## Acceptance Criteria

- `meet.md` is generated automatically when the meeting session finalizes.
- It contains meeting metadata.
- It contains detected participants when available.
- It contains complete transcript segments with speaker and timestamps when available.
- It contains media references for recording/audio/video/diagnostics when available.
- It contains no AI-generated summary, decisions, action items, or interpretation.
- It is registered as a Ravi artifact with lineage.
- The origin session receives the artifact as context after generation.


---
id: prox/intake/agora-anam
title: "Agora + Anam Intake"
kind: feature
domain: prox
capability: intake
feature: agora-anam
capabilities:
  - agora-rtc
  - agora-convoai
  - anam-avatar
  - devin-handoff
tags:
  - prox-city
  - agora
  - convoai
  - anam
  - avatar
  - cognition-hackathon
applies_to:
  - ../../../ravi/cognition-hackathon/src/lib/agora.ts
  - ../../../ravi/cognition-hackathon/src/app/page.tsx
  - ../../../ravi/cognition-hackathon/src/app/api/agora
owners:
  - ravi-dev
status: draft
normative: true
---

# Agora + Anam Intake

## Intent

This feature is the concrete hackathon path for proving live `prox.city` intake:

```text
Agora RTC voice/video -> Agora ConvoAI agent -> Anam avatar -> profile -> opportunity -> hybrid deal -> Devin handoff
```

The goal is to use the existing Agora and Anam credits/integration instead of searching for new providers.

## Provider Decisions

- Agora RTC MUST provide the live audio/video room.
- Agora ConvoAI MUST run the intake agent in the same channel as the human.
- Anam SHOULD provide the visual avatar for the intake agent.
- Devin SHOULD receive the approved deal handoff for machine-executable work.
- The system MUST NOT do provider shopping before the first stable E2E loop works.

## Demo Roles

- Human participant: joins with camera and microphone.
- ConvoAI agent: conducts the intake conversation in Portuguese.
- Anam avatar: represents the agent visually in the main tile when video publishes.
- Devin: executes or formalizes the machine side of the approved hybrid deal.

## UI Requirements

- The main tile SHOULD represent the agent/avatar.
- The human camera SHOULD appear as a smaller PiP or secondary tile.
- The UI SHOULD display transcript/history, generated profile, matched opportunity, hybrid deal, and handoff.
- The UI MAY show a compact technical event log for live debugging.
- If avatar video fails, the UI MUST still support a voice-only agent state and keep the demo flowing.

## Intake Prompt Requirements

The intake agent MUST interview someone who wants to be found and hired/activated by agents or humans.

The agent MUST ask short questions in Portuguese about:

- skills and proficiency;
- accepted tasks/projects;
- availability, timeframe, and compensation expectation;
- quality criteria and boundaries;
- how agents should contact the person and what information must be provided first.

The agent MUST NOT frame the human as simply "looking for a solution". The person is offering capacity and agency.

## Agora Runtime Requirements

The server-side join flow MUST provide:

- stable channel name;
- RTC token for the human;
- ConvoAI token for the agent;
- `agent_rtc_uid` as a string;
- `remote_rtc_uids` as string array;
- `advanced_features.enable_rtm=true`;
- `parameters.transcript.enable=true`;
- `parameters.data_channel=rtm`;
- metrics/error visibility enabled when available;
- avatar config when Anam credentials are present.

Recommended demo UIDs:

- human: `1002`;
- ConvoAI agent: `1001`;
- Anam avatar: `1003`.

## Anam Avatar Requirements

When enabled, the Anam avatar config SHOULD include:

- vendor: `anam`;
- `api_key`;
- `avatar_id` when configured;
- `agora_uid`;
- `agora_token`;
- `sample_rate=24000`;
- `quality=high`;
- `video_encoding=AV1` unless testing proves another value is safer.

Anam is allowed to fail gracefully. Avatar failure MUST NOT block intake if Agora audio/history still works.

## Data Flow

1. Browser requests RTC token.
2. Browser joins Agora RTC with camera and microphone.
3. Browser requests `/join` for the ConvoAI agent.
4. Server builds ConvoAI payload and optional Anam avatar payload.
5. Agent joins the RTC channel.
6. Avatar publishes remote video when available.
7. UI subscribes to remote audio/video.
8. Human completes short intake.
9. App reads ConvoAI history/transcript.
10. History becomes a structured `person_profile`.
11. Profile matches a seeded opportunity.
12. App generates a `hybrid_deal`.
13. Human approves.
14. App generates Devin handoff prompt.

## Acceptance Criteria

Minimum demo:

- browser joins RTC with local audio/video;
- ConvoAI agent reaches `RUNNING`;
- the agent conducts Portuguese intake;
- history contains user transcript;
- profile and deal are generated;
- human can approve/copy Devin handoff;
- `/leave` stops the agent.

Strong demo:

- Anam avatar appears in the main tile;
- agent audio is natural and audible;
- profile/deal generation happens without manual reload;
- Devin produces a reviewable output from the handoff;
- the pitch clearly shows human-in-the-loop.

## Known Failure Modes

- `/join` returns `RUNNING`, but remote media has not published yet.
- History contains `user` but no `assistant`; this points to LLM/TTS/runtime, not RTC.
- Avatar fails because TTS sample rate, provider config, or encoding is incompatible.
- The UI renders into the same DOM node that Agora owns and breaks video playback.
- Custom avatar/provider work consumes the demo window before profile/deal/Devin are closed.

## Non-Goals

- multi-user rooms;
- recording;
- payments;
- real outreach automation;
- full avatar provider abstraction;
- production-scale marketplace logic.

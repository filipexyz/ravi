---
id: channels/meetings/native-channel
mode: runbook
---

# Runbook

## Inspect The Current Meeting Flow

```bash
ravi meetings join --provider google-meet --url <url> --dry-run --json
ravi artifacts events <artifact-id> --json
ravi artifacts show <artifact-id> --json
```

Read the run directory metadata and diagnostics before repeating a join.

## Inspect Channel Source And Delivery

```bash
ravi sessions trace <session> --since 2h --explain
ravi sessions info <session>
ravi self context --json
```

Confirm that meeting-originated prompts carry:

- `source.channel = "meet"`;
- provider metadata such as `provider = "google-meet"`;
- canonical meeting room id;
- origin session/agent references;
- source message/event id when available.

## Debug Observer Attachment

```bash
ravi observers rules list --json
ravi observers rules explain --session <session>
ravi observers list --json
```

If a meeting observer does not attach:

1. Confirm the source session has meeting channel metadata.
2. Confirm the observer rule selector matches that metadata or tag.
3. Confirm the observer agent exists.
4. Confirm the rule has a supported mode and permission grants.

## Debug Voice/Text Output

For speech output, prove:

1. runtime emitted a response or explicit speech intent;
2. gateway selected meeting delivery for `channel=meet`;
3. provider accepted the speech request;
4. provider emitted `meeting.agent.speech.started` and terminal status;
5. artifact captured outbound agent speech.

For text output, prove:

1. runtime emitted text intended for channel delivery;
2. target has `channel=meet`;
3. provider supports text chat delivery;
4. provider returned message id or diagnostic failure;
5. artifact captured outbound agent text.

## Incident Classification

- No meeting source: join/route/session binding issue.
- Source exists but no observer: observer rule selector issue.
- Runtime speaks but room is silent: meeting delivery/provider speech issue.
- Room speech exists but transcript missing: capture/transcription issue.
- Artifact missing outbound speech/text: raw artifact renderer/provenance issue.

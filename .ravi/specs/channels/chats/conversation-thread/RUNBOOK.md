# Conversation Thread / RUNBOOK

## Debug Flow

Use this flow when a transcript shows the wrong speaker announcement, missing continuation, or incorrect per-person tool scope.

## 1. Confirm Actor Metadata

Inspect the original message/session trace and verify the inbound message carried actor metadata:

```bash
ravi sessions trace <session> --message <message-id> --explain --raw
```

Look for:

- `actor_type`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- raw sender id provenance
- `source_chat_id` / canonical `chat_id`

If actor metadata is missing, debug chat/contact resolution before debugging conversation thread state.

## 2. Confirm Floor Transition

Check the ordered prompt items around the incident:

```bash
ravi sessions trace <session> --since 30m --only dispatch --raw
ravi sessions trace <session> --since 30m --only adapter --raw
```

Expected transitions:

- no previous human floor -> started speaking
- different contact -> now has the floor
- system event -> interruption only
- same contact after system event -> continuing with previous speaker

## 3. Confirm Prompt Envelope

Inspect the adapter request for:

- agent-visible `speaker_annotation`
- structured `active_actor_context`
- no duplicated full channel header between contiguous messages from the same speaker

Use:

```bash
ravi sessions trace <session> --turn <turn-id> --show-user-prompt --raw
```

## 4. Confirm Personal-Resource Scope

For calendar or similar tools, inspect the tool authorization context. It should reference the active speaker contact/platform identity, not the whole chat participant list.

If the active speaker is unresolved, `system`, `agent`, or `unknown`, the personal-resource tool should deny scoped access unless an explicit higher-scope context exists.

## Common Fix Locations

- missing actor metadata: inbound channel normalization or router persistence
- wrong floor transition: conversation thread state builder
- annotation present but tool scope wrong: runtime request builder / host permission context
- tool grants group-wide access: personal-resource authorization layer

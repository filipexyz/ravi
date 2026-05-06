# Conversation Thread / CHECKS

## Checks

## Regression Scenarios

### First Speaker

Given a session with no `floor_actor`, when a resolved contact sends a message, Ravi should inject a `speaker_annotation` equivalent to:

```text
Fulano começou a falar.
```

The prompt envelope should also carry `active_actor_context.contact_id` and `platform_identity_id` when available.

### Same Speaker Contiguous Messages

Given the same contact sends multiple contiguous messages, Ravi should inject the speaker annotation only before the first message in that contiguous run.

### Speaker Switch

Given `floor_actor = Luis` and `Rafa` sends the next human-authored message, Ravi should inject a speaker-switch annotation equivalent to:

```text
Agora Rafa está com a palavra.
```

The active actor context should switch to Rafa.

### System Interruption

Given `floor_actor = Luis`, when a `[System] Inform`, task event, daemon notice, trigger, or recovery notice is injected, the floor actor should remain Luis.

If Luis speaks next, Ravi should inject a continuation annotation equivalent to:

```text
Continuando com Luis.
```

If Rafa speaks next, Ravi should inject a speaker-switch annotation for Rafa.

### Unresolved Speaker

Given a message actor cannot be resolved to a contact/platform identity, Ravi may display a fallback label for comprehension, but personal-resource tools should deny scoped access.

### Calendar Scope

Given Luis is the active speaker, a calendar tool should only see calendars authorized for Luis's contact/platform identity.

Given Rafa is present in the same group but is not the active speaker, Luis's prompt should not grant access to Rafa's calendar.

Given a system event occurs after Luis speaks, the system event itself should not create new calendar authority.

## Suggested Test Areas

- prompt construction tests for annotation generation
- runtime request builder tests for `active_actor_context`
- host permission tests for per-speaker personal-resource scoping
- session trace tests proving actor metadata is persisted with prompt/event transitions

## Commands

Run existing related coverage while this feature is being implemented:

```bash
bun test src/omni/ src/runtime/ src/gateway-session-trace.test.ts src/router/chat-schema.test.ts
```

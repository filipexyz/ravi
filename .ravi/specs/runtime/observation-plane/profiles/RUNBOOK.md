# Observer Profiles / RUNBOOK

## Inspect Profiles

```bash
ravi observers profiles list
ravi observers profiles show task-reporter
```

## Preview Rendering

Preview one event:

```bash
ravi observers profiles preview task-reporter --event message.user
```

Preview a full end-of-turn delivery:

```bash
ravi observers profiles preview task-reporter --delivery end_of_turn
```

The preview should include:

- resolved profile source;
- profile version;
- event fragments;
- final delivery prompt;
- placeholder context used for rendering.

## Validate Profiles

```bash
ravi observers profiles validate
ravi observers profiles validate task-reporter
```

Validation failures should be fixed in the profile source file, not patched in runtime rendering code.

## Create a Workspace Profile

```bash
ravi observers profiles init task-reporter-v2 --preset task-reporter --source workspace
```

Expected layout:

```text
.ravi/observers/profiles/task-reporter-v2/
  PROFILE.md
  delivery/end-of-turn.md
  delivery/realtime.md
  delivery/debounce.md
  events/default.md
  events/message-user.md
  events/message-assistant.md
  events/turn-complete.md
  events/turn-failed.md
  events/turn-interrupt.md
```

## Debug Bad Observer Prompts

1. Identify the observer binding from `ravi observers bindings list --source-session <session>`.
2. Inspect the binding profile id, version, source, and snapshot.
3. Preview the profile with similar event context.
4. Validate the profile.
5. Check whether the rule overrides event filters or delivery policy.
6. If the binding uses an old snapshot, run explicit reconciliation rather than editing the source profile and expecting old bindings to change.

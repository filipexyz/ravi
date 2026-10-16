---
id: task-observer
version: "1"
label: Task Observer
description: Built-in observer of every observed task. Reads the worker and answers with a structured verdict that the runtime applies.
defaults:
  eventTypes:
    - message.user
    - message.assistant
    - tool.start
    - tool.end
    - turn.complete
    - turn.failed
    - turn.interrupt
  deliveryPolicy: end_of_turn
  mode: report
templates:
  delivery:
    realtime: ./delivery/realtime.md
    debounce: ./delivery/debounce.md
    end_of_turn: ./delivery/end-of-turn.md
  events:
    default: ./events/default.md
    message.user: ./events/message-user.md
    message.assistant: ./events/message-assistant.md
    tool.start: ./events/tool-start.md
    tool.end: ./events/tool-end.md
    turn.complete: ./events/turn-complete.md
    turn.failed: ./events/turn-failed.md
    turn.interrupt: ./events/turn-interrupt.md
rendererHints:
  label: Task observer
---

# Task Observer

The runtime attaches this profile to every task whose profile turns the
observer on (`observer.enabled` in the task profile). The worker never reports
status; this observer reads its turns, the full final reply and a digest of the
tools it ran, and answers with one `<task-verdict>` block. The runtime parses
the verdict and changes the task: the observer has no tools and no task grants.

The templates need the `input.task.*` context the runtime builds for a source
session with an active task, so a rule that points at this profile only renders
for task sessions.

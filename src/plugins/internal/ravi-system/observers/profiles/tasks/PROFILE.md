---
id: tasks
version: "1"
label: Task Status Observer
description: Observes task worker sessions and renders status-reporting prompts for an observer.
defaults:
  eventTypes:
    - message.user
    - message.assistant
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
    turn.complete: ./events/turn-complete.md
    turn.failed: ./events/turn-failed.md
    turn.interrupt: ./events/turn-interrupt.md
rendererHints:
  label: Task status observer
---

# Task Status Observer

Use this observer profile when a task worker should focus on execution while a
sidecar observer keeps durable task status synchronized from source-session
events.

The observer should treat source events as evidence, inspect the task state when
needed, and perform idempotent updates tied to source event ids or turn ids.

---
id: default
version: "1"
label: Default Observer
description: Default Markdown renderer for Ravi observation deliveries.
defaults:
  eventTypes:
    - message.user
    - message.assistant
    - turn.complete
    - turn.failed
    - turn.interrupt
  deliveryPolicy: end_of_turn
  mode: observe
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
  label: Default observer
---

# Default Observer

System fallback profile for Observation Plane prompts.

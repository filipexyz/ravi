---
id: compact
version: "1"
label: Compact Observer
description: One short block per source turn (person, agent messages, tool count, end), for cheap observers.
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
    realtime: ./delivery/digest.md
    debounce: ./delivery/digest.md
    end_of_turn: ./delivery/digest.md
  events:
    default: ./events/default.md
rendererHints:
  label: Compact observer
---

# Compact Observer

Renders a delivery as one block per source turn: what the person said, how many messages the agent
sent and its last one, tool calls as a count, and how the turn ended. Ids, usage, cost and provider
metadata stay in the delivery metadata (`_observation`), out of the prompt.

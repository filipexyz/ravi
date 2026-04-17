# WhatsApp Overlay DOM Model

## Goal

Stop treating WhatsApp Web as "a pile of selectors".

Model it as:

- `surface`: left pane, center pane, right drawer, modal layer
- `component`: header, timeline, composer, selected chat row, message anchor
- `signal`: role, aria, data-testid, title, contenteditable, visibility, geometry
- `relation`: inside, below, right-of, adjacent
- `extractor`: title, chat id, message id, semantic labels

## Rule

Never trust a single class name.

Detection flow:

1. collect candidates for a logical component
2. score by stable signals
3. reject candidates that break structural relations
4. use geometry as tie-breaker
5. require the same winning match across consecutive ticks
6. synthesize the selector path from the winning component

## Practical mapping

- `chat-list`
  left pane, scrollable, repeated rows
- `selected-chat-row`
  current row with `aria-selected="true"`
- `conversation-root`
  center pane with header + timeline + composer
- `conversation-header`
  top area of the center pane
- `timeline`
  scrollable message area
- `message-anchor`
  repeated visible message containers used for inline insertion
- `composer`
  bottom editable message input
- `drawer`
  right pane for details/config
- `modal`
  blocking overlay layer

## Ravi-Owned Surfaces

The overlay should distinguish between:

- `native WhatsApp surfaces`
- `Ravi-owned surfaces`

Current Ravi-owned surfaces:

- `quiet-rail`
  compact context strip below the conversation app bar
- `chat-row-badge`
  metadata chip attached to native WhatsApp rows
- `message-chip`
  inline chip near author/time anchors in the timeline
- `message-popover`
  fixed floating detail panel tied to one message

Target Ravi-owned surface for navigation:

- `cockpit-sidebar`
  a full right-hand sidebar that visually behaves like a sibling of the native left pane

This matters because navigation and context should not share the same anchor by default:

- `navigation` belongs to a sidebar/list surface
- `current-chat context` belongs near the app bar and timeline

## Why this matters

This gives us a stable path for:

- screen detection
- session correlation
- inline card injection
- future action menus inside WhatsApp
- later message-level enrichment without chasing class renames

It also gives us one product constraint that became clear in live testing:

- navigation must be `chat-centric`
- `agent` is supportive metadata, not the primary row identity

It also defines the build loop:

- first predict the right anchor and UI shape from the CLI/bridge
- then materialize the winning pattern inside the extension
- keep DOM control available as a permanent probing/debug surface

## Next step

Turn this spec into a runtime matcher:

- compute component matches with score + confidence
- persist the winning selector for each component in the current tick
- expose a debug view with `component -> selector -> score -> reasons`
- use that same winning selector map as the source for extension-side materialization

# WhatsApp Overlay Cockpit v1

## Purpose

Define the first product-grade cockpit for WhatsApp Web inside Ravi.

This document is intentionally split into:

- `current reality`
- `rejected pattern`
- `target design`

So we do not confuse working experiments with the chosen product direction.

## Current Reality

Today the overlay already proves five important capabilities:

1. WhatsApp Web screen detection works in real time.
2. Chat-to-session resolution works through `chatId`, title, and manual binding.
3. Live Ravi state can be shown on top of the native chat list.
4. Conversation-level UI can live below the app bar (`quiet rail`).
5. Message-level metadata and transcript popovers can be injected into the timeline.

This means the core question is no longer "can we extend WhatsApp Web?".

The real question is:

`which Ravi surfaces belong in which part of the WhatsApp layout?`

## Rejected Pattern

The recent floating stack of "other agents from the last 24h" was a useful experiment, but the wrong navigation model.

Why it felt bad:

- it was `agent-centric`, but WhatsApp navigation is `chat-centric`
- it lived near the app bar, but cross-chat navigation belongs to a navigation column
- clicking depended on a visible chat row already being present in the left pane
- when the row was not visible, the interaction degraded to best-effort instead of deterministic behavior
- it created a second navigation system instead of extending the one WhatsApp already teaches the user to use

The decision is now explicit:

- `agent` is metadata
- `chat` is the primary object for navigation

## Product Decision

The cockpit should evolve into a three-column mental model:

- left: native WhatsApp chat list
- center: native WhatsApp conversation
- right: Ravi cockpit sidebar

The right sidebar should visually borrow from the left pane:

- search at the top
- scrollable sections
- row-based navigation
- compact badges and states
- low-friction scanning

This keeps the chat in the middle as the main stage, while Ravi becomes an operational layer instead of a floating gadget.

## Cockpit v1 Goal

`In 5 seconds, Luís should understand what Ravi is doing across recent chats and be able to jump deterministically to the next chat that matters.`

## Information Architecture

### 1. Search

Top input in the right sidebar.

Search keys:

- chat title
- session name
- agent id
- chat id / jid

Behavior:

- filters the right-sidebar rows immediately
- selecting a row opens the corresponding WhatsApp chat

### 2. Recent Chats

Primary section.

Each row represents one concrete chat, never one agent.

Row payload:

- `chat title`
- `agent badge`
- `live state`
- `recency`
- optional compact route metadata later

Example:

`Ravi - Dev · dev · thinking · 12s`

### 3. Hot Sessions

Secondary section, focused on activity rather than recency.

Only sessions in states such as:

- `thinking`
- `streaming`
- `awaiting approval`
- `blocked`

Rows still map to chats, not abstract agents.

### 4. Active Chat Context

This stays near the center conversation surface, not in the navigation list.

It includes:

- `quiet rail` below the app bar
- message-level chips and popovers

That means:

- right sidebar = navigation and radar
- center surfaces = current-chat context

## Data Model

The right sidebar should resolve to a chat-centric item like:

```ts
interface CockpitChatItem {
  chatId: string;
  title: string;
  sessionKey: string;
  sessionName: string;
  agentId: string;
  activity: "idle" | "thinking" | "streaming" | "compacting" | "awaiting_approval" | "blocked";
  summary?: string;
  updatedAt: number;
  accountId?: string | null;
  channel: "whatsapp";
}
```

Important rule:

- multiple sessions may exist in Ravi
- navigation chooses a `chat item`
- the row can show `agent` and `session`, but it must open a chat

## Interaction Rules

### Deterministic Open

Opening a row should follow this order:

1. if the native WhatsApp row is already visible, click it
2. otherwise, use the native WhatsApp search input to find the chat
3. once the result appears, click the matching row
4. if the chat still cannot be opened, show a clear failure state

Best-effort silent failure is not acceptable for navigation.

### Selection

When the current conversation already matches a sidebar row:

- highlight that row
- keep the row state live

### Search Scope

The right sidebar search is Ravi-owned, but it should help open native WhatsApp chats.

That means its result rows must map to:

- a known `chatId`
- or a known title plus confidence

## v1 Visual Language

The visual target is not "new app inside WhatsApp".

It should feel like:

- a denser, smarter sibling of the left pane
- slightly more operational than WhatsApp
- still quiet enough to coexist with the native UI

Stylistic rules:

- compact rows
- subtle state color
- agent as badge, not headline
- low-noise typography
- no floating secondary navigation competing with the app bar

## Non-Goals

Not part of this first cockpit cut:

- full config editor inside the sidebar
- route/policy authoring flows
- timeline-wide event stream in the right pane
- replacing the native WhatsApp left pane

## Implementation Phases

### Phase 1. Read Model

Bridge exposes a chat-centric collection for the right sidebar:

- recent chats
- hot sessions
- current chat

This should not be grouped by agent first.

### Phase 2. Sidebar Shell

Materialize the right sidebar structure:

- search
- recent chats
- hot sessions

No fancy actions yet.

### Phase 3. Deterministic Navigation

Implement reliable open behavior:

- visible row click
- native search fallback
- selected-row confirmation
- explicit failure feedback

### Phase 4. Operational Polish

Only after navigation feels solid:

- compact metadata
- quick actions
- approval badge
- route / policy / instance hints

## Code Surfaces

Current code relevant to this direction:

- overlay bridge:
  [`src/whatsapp-overlay/bridge.ts`](/Users/luis/dev/filipelabs/ravi.bot/src/whatsapp-overlay/bridge.ts)
- overlay model:
  [`src/whatsapp-overlay/model.ts`](/Users/luis/dev/filipelabs/ravi.bot/src/whatsapp-overlay/model.ts)
- content script:
  [`extensions/whatsapp-overlay/content.js`](/Users/luis/dev/filipelabs/ravi.bot/extensions/whatsapp-overlay/content.js)
- extension styles:
  [`extensions/whatsapp-overlay/styles.css`](/Users/luis/dev/filipelabs/ravi.bot/extensions/whatsapp-overlay/styles.css)
- DOM model:
  [`src/whatsapp-overlay/DOM_MODEL.md`](/Users/luis/dev/filipelabs/ravi.bot/src/whatsapp-overlay/DOM_MODEL.md)

## Summary

The proven thesis is:

- Ravi belongs inside WhatsApp Web

The corrected product thesis is:

- navigation must be `chat-centric`
- operational context can be `agent-aware`
- the right place for cross-chat cockpit behavior is a right sidebar, not a floating stack near the app bar

# WhatsApp Overlay RBAC

## Decision

The WhatsApp Overlay does not act as implicit admin.

The enforcement point is the local bridge in `src/whatsapp-overlay/bridge.ts`.

The actor is always:

- the current Ravi session
- resolved from the active chat snapshot or explicit `actorSession`

There is no approval flow in this first cut.

If the actor does not have the required relations, the bridge fails closed.

## Read Model

The Omni panel snapshot now carries:

- `actor`
  - `sessionKey`
  - `sessionName`
  - `agentId`
  - `capabilities`
- `auth` on view items
  - `visibility: "full" | "opaque"`
  - `view.allowed`
  - `view.matched`
  - `view.missing`
  - `view.reason`

Current item types with auth:

- `instances`
- `agents`
- `sessions`
- `chats`
- `groups`

## UI Rules

The content script does not decide access on its own.

It materializes bridge decisions like this:

- `full` => render normal row
- `opaque` => keep the row visible but dimmed
- missing relations => show in title / hint text
- denied writes => disable the CTA and keep the reason visible

This preserves operator awareness without leaking full details.

## Current Object Types

The overlay uses the existing REBAC surface plus Omni-specific objects:

- `access session:<name-or-key>`
- `modify session:<name-or-key>`
- `view agent:<agentId>`
- `execute group:sessions`
- `execute group:agents`
- `read instance:<instanceName>`
- `read route:<instance>:<pattern>`
- `modify route:<instance>:<pattern>`

## Current Write Checks

### Bind existing session

Requires:

- `access session:<target>`
- `modify route:<instance>:<pattern>`

### Create session and bind

Requires:

- `execute group:sessions`
- `view agent:<target>`
- `modify route:<instance>:<pattern>`

### Migrate current session to another agent

Requires:

- `modify session:<current>`
- `execute group:sessions`
- `view agent:<target>`
- `modify route:<instance>:<pattern>`

### Create agent + session + bind

Requires:

- `execute group:agents`
- `execute group:sessions`
- `modify route:<instance>:<pattern>`

## Error Contract

When a write is denied, the bridge returns `403` with:

```json
{
  "ok": false,
  "error": "Permission denied",
  "missingRelations": [
    "modify route:luis:group:120363..."
  ]
}
```

The UI should surface these relations directly instead of collapsing them into a generic error.

## Notes

- The actor is intentionally fixed to the current session, not a pinned session.
- Read items remain visible when denied; they should not disappear.
- This cut is bridge-enforced and UI-materialized, but still approval-free by design.

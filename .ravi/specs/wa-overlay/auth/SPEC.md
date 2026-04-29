# wa-overlay extension auth

Status: active
Owner: dev (task-478b2acf)
Last updated: 2026-04-28

## Goal

Define how the Chrome extension authenticates against one or more Ravi gateways after the bridge is removed.

The extension is a manifest v3 service worker (`extensions/whatsapp-overlay/background.js`) that today calls `127.0.0.1:4210` with no auth at all. Post-migration it must:

1. Hold a list of gateway servers (so the operator can switch between local daemon, remote daemon, dev/prod, etc.).
2. Present a runtime context-key (`rctx_*`) on every gateway call, scoped to the active server.
3. Operate within a least-privilege capability bundle.

## Threat model

- The extension runs on the operator's own machine, in their browser profile.
- A gateway listens on `127.0.0.1:RAVI_HTTP_PORT` (loopback only by default; binding to non-loopback requires `RAVI_GATEWAY_NETWORK_AUTHORIZED=1`, see `src/webhooks/http-server.ts:395`).
- Realistic attackers:
  - Malicious page/extension calling the loopback gateway from the browser. Today nothing protects the bridge against this. The new model requires possession of the active server's context-key, which a hostile page cannot read out of `chrome.storage.local`.
  - Cross-server confusion: extension accidentally sends a key issued for server A to server B. Mitigation: every server entry is `{ name, baseUrl, contextKey }`; the extension always sends the key bound to the same entry as the request URL.

## Multi-server model

The extension stores a list of server entries and an "active" pointer:

```ts
type ServerEntry = {
  id: string;        // local stable id, generated client-side
  name: string;      // operator-friendly label ("local", "vps prod", etc.)
  baseUrl: string;   // e.g. "http://127.0.0.1:4399"
  contextKey: string; // rctx_* issued for this baseUrl
  addedAt: number;
};

type ExtensionAuthState = {
  servers: ServerEntry[];
  activeId: string | null;
};
```

Storage:

- `chrome.storage.local.set({ ravi_auth: { servers, activeId } })` — local to the browser profile, not synced.
- Keys never leave the extension once stored; they appear only in the options UI, redacted by default with a "reveal" affordance.

UI (extension options page):

- List of servers with `name`, `baseUrl`, redacted key, "active" radio.
- Buttons: `Add server`, `Edit`, `Delete`, `Set active`, `Test connection` (issues a no-op call against the gateway to confirm the key works).
- Optional quick-switcher in the WhatsApp overlay top-bar so the operator can flip between daemons without leaving WhatsApp Web.

Active selection:

- Every SDK call wraps the active server's `baseUrl` and `contextKey`.
- Switching active triggers a fresh snapshot fetch — old in-memory data is discarded since it belonged to a different daemon.

## Issuing keys

Of the three options previously considered:

- **(1) manual paste** — works, UX is acceptable for power users; chosen for v1.
- **(2) `ravi overlay issue-key` clipboard helper** — nice-to-have sugar over `ravi context issue` if/when it lands; not blocking.
- **(3) one-shot localhost endpoint** — rejected; any local process can race the listener.

### v1 flow (manual paste, multi-server)

1. Operator runs on the target daemon's host:
   ```bash
   ravi context issue --cli-name overlay-extension --capabilities <bundle>
   ```
   (capability bundle below). Output prints `rctx_*` and the gateway URL.

2. In the extension options page, operator clicks `Add server`, enters:
   - `name` (free-form label),
   - `baseUrl` (the gateway URL),
   - `contextKey` (the `rctx_*`).

3. Extension stores the entry in `chrome.storage.local` and offers `Set active` and `Test connection`.

4. Active server's `{ baseUrl, contextKey }` is passed to `createHttpTransport` from `@ravi-os/sdk/transport/http`. Every call sends `Authorization: Bearer <contextKey>`.

5. On 401/403, the extension surfaces a toast pointing to the options page; the operator either re-issues the key on the daemon or switches to a different active server.

### Future sugar (out of scope for v1)

- `ravi overlay issue-key` — a thin wrapper around `ravi context issue overlay-extension` that copies the resulting key to the clipboard and prints a one-line "paste this in the extension options page" hint. Pure UX; non-blocking. Note: this CLI lives under `context` operationally, but a dedicated wrapper command MAY be added later if it earns its keep.

## Capability bundle

Derived from the migration plan in `.ravi/specs/wa-overlay/migration/SPEC.md`. The extension reproduces the local control plane in the browser, so the bundle is broad — but it remains expressed in **existing** capability shapes (no `overlay:*` namespace).

Required:

- Read substrate state to assemble UI: `view sessions:*`, `view tasks:*`, `view artifacts:*`, `view insights:*`, `view instances:*`, `view routes:*`, `view agents:*`.
- Drive sessions: `read sessions/*`, `mutate sessions/*` (covers send/abort/reset/set-thinking/rename).
- Dispatch tasks: `dispatch tasks/*` (and `mutate tasks/*` if `tasks dispatch` requires it).
- Mutate routes/instances for omni-route flows: `mutate routes/*`, `mutate instances/*`.
- Read artifact bytes: `read artifacts/*`.

The bundle is broad because the overlay reproduces the operator surface. That is acceptable for a developer-only extension running on the operator's own machine. If/when the overlay ships to non-operator users, this bundle should be partitioned per UI feature (e.g., a `view-only` extension).

## Storage schema

```jsonc
// chrome.storage.local.ravi_auth
{
  "servers": [
    {
      "id": "srv_local_4399",
      "name": "local",
      "baseUrl": "http://127.0.0.1:4399",
      "contextKey": "rctx_...",
      "addedAt": 1745123456789
    },
    {
      "id": "srv_vps_prod",
      "name": "vps prod",
      "baseUrl": "https://ravi.example.com",
      "contextKey": "rctx_...",
      "addedAt": 1745123512345
    }
  ],
  "activeId": "srv_local_4399"
}
```

## Rotation and revocation

- `ravi context revoke <id>` revokes a key on the daemon side.
- The extension surfaces 401/403 on the next call and prompts the operator to re-issue and update the affected server entry.
- No silent refresh — the operator owns the lifecycle, matching how Ravi treats other CLIs.
- Removing a server entry is a local operation; it does not revoke the underlying daemon-side key (operator must `ravi context revoke` separately if desired).

## Out of scope

- Auth UX inside the WhatsApp Web overlay panel itself beyond the active-server quick-switch (operator interacts with the extension options page for full management).
- Per-feature capability partitioning (single bundle today; partition later when use cases justify it).
- Token expiry/refresh — context-keys do not auto-expire; rotation is operator-driven.
- Cross-machine sync of the server list — local to the browser profile.

## Validation

- Operator can add a server, set it active, and the overlay loads correctly.
- Adding a second server and switching active loads data from the new daemon and discards the previous daemon's state.
- Removing a key entry from `chrome.storage.local` (or revoking it on the daemon) makes every call return 401 with a clear surfaced error.
- `ravi context list` on each daemon shows the issued key with `cliName=overlay-extension` and the documented capability bundle.
- `ravi context revoke <id>` immediately blocks the extension on its next call.
- The extension uses `createHttpTransport({ baseUrl, contextKey })` from `@ravi-os/sdk/transport/http` exclusively; no custom HTTP fetch helpers.

# Ravi Desk

First Flutter slice of a desktop (and later iOS/Android) client for a running
local [Ravi](https://github.com/filipexyz/ravi) daemon.

This app lives at `apps/ravi_desk` on purpose:

- `packages/` is reserved for generated first-class SDKs (`@ravi-os/sdk`, Swift).
- `src/apps/` is Ravi's in-runtime app domain, not a host UI.
- Flutter is the product shell so the same codebase can target Windows, macOS,
  Linux now and grow to iOS/Android without a Mac being required to land this PR.

There is **no official Dart or Rust SDK**. Ravi Desk uses a thin, hand-written
HTTP client that mirrors only the commands this screen needs
(`agents.list`, `agents.session`, `sessions.read`, `sessions.send`,
`context.whoami`) plus SSE on `/api/v1/_stream/sessions/<name>`. It talks to the
HTTP gateway, not NATS.

## Run

```bash
# From this directory
flutter pub get
flutter run -d linux
# flutter run -d windows
# flutter run -d macos
```

iOS and Android folders are generated so the project can grow there. You do not
need Xcode to review or merge this slice.

Pass connection settings as environment variables (desktop) or compile-time
defines:

```bash
RAVI_BASE_URL=http://127.0.0.1:7777 \
RAVI_CONTEXT_KEY=rctx_... \
flutter run -d linux
```

```bash
flutter run -d linux \
  --dart-define=RAVI_BASE_URL=http://127.0.0.1:7777 \
  --dart-define=RAVI_CONTEXT_KEY=rctx_...
```

You can also paste the base URL and context key in **Gateway settings** (gear
on the profile row). Nothing is hardcoded.

## Daemon

The app expects the Ravi HTTP gateway on `http://127.0.0.1:7777` by default.

```bash
RAVI_HTTP_PORT=7777
RAVI_HTTP_HOST=127.0.0.1
ravi daemon start
```

Create a runtime context key (`rctx_*`):

```bash
ravi daemon init-admin-key
# or a narrower key for this UI:
ravi context issue desk --ttl 8h --json
```

If the daemon is down or the key is missing, the first screen is a connect/setup
panel instead of a fake chat.

## Wire contract

Commands:

```text
POST http://127.0.0.1:7777/api/v1/<group-segments>/<command>
Authorization: Bearer <rctx_*>
x-ravi-sdk-version: ravi-desk/0.1.0
```

Flat JSON body. Example: `POST /api/v1/agents/list` with `{"limit":"50"}`.

Streams:

```text
GET /api/v1/_stream/sessions/<name>
GET /api/v1/_stream/events
Accept: text/event-stream
```

If SSE is unavailable the UI falls back to polling `sessions.read`.

## Analyze

```bash
dart analyze
# or
flutter analyze
```

## Why not Tauri / rust-codegen / `@ravi-os/sdk`

Luís (Rbbt Lab) moved the host UI to Flutter so one codebase can cover Windows
and later iOS/Android. `@ravi-os/sdk` is TypeScript and cannot run inside
Flutter. A generated Dart/Rust SDK for the entire registry is out of scope for
this slice — the thin client only covers the first screen.

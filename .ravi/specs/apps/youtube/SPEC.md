---
id: apps/youtube
title: "YouTube Ravi App"
kind: capability
domain: apps
capabilities:
  - youtube
tags:
  - ravi-apps
  - google
  - youtube
applies_to:
  - src/apps/youtube
  - src/cli/commands/youtube.ts
owners:
  - ravi-dev
status: active
normative: true
---

# YouTube Ravi App

## Intent

Define the native, parallel Phase 1 migration of the legacy `sde yt` surface
to a Ravi App. The public app route is `ravi youtube`; the implementation CLI
bound by the manifest is the registered static command `ravi yt`. The app
exposes official YouTube Data API v3 and YouTube Analytics API v2 resources
while preserving the SDE implementation as an untouched fallback. Real
credential onboarding and authenticated live proof are deliberately outside
Phase 1.

## Invariants

- The app MUST use the native app ID `youtube`.
- `interfaces.cli.command` MUST identify `ravi yt` as the real, registered
  static implementation CLI.
- `ravi youtube <operation>` MUST be the canonical App Router route.
  `ravi apps run youtube <operation>` MUST remain the explicit router fallback.
- Direct `ravi yt <command>` is an implementation/debug and local-operator
  compatibility surface. It is not a second App executor, and runtime app
  callers MUST use the App Router.
- Every CLI-backed manifest operation MUST invoke `ravi yt ...`; it MUST NOT
  invoke `ravi youtube ...` and recursively re-enter the App Router.
- UI, SDK, runtime tools, and automations MUST invoke declared `youtube.*`
  operations through the generic App Router. Generated decorator SDK metadata
  for `ravi yt` MAY remain for compatibility but MUST NOT define a separate app
  implementation.
- The manifest MUST declare `context.allow` with the reviewed child-context
  ceiling required by the implementation CLI. For the current static command
  boundary this MUST be `execute:group:yt`; it MUST NOT use inheritance or a
  wildcard.
- Manifest `permissions` gate the caller and operation. `context.allow` only
  bounds the child CLI and MUST NOT be treated as an app permission grant.
- In runtime context the App Router MUST launch `ravi yt` with a fresh child
  context named `app:youtube`, bounded by the parent and the manifest ceiling.
  It MUST NOT forward the parent context key or synthesize agent/session
  identity environment variables.
- The native client MUST call only official Google endpoints under `https://www.googleapis.com/youtube/v3` and `https://youtubeanalytics.googleapis.com/v2`.
- The native client MUST NOT execute `sde`, import SDE modules, read SDE credential/token files, or alter the legacy SDE code or runtime.
- Phase 1 MUST NOT implement OAuth consent/callback/token refresh, use a real token, or perform an authenticated live request.
- Missing credentials MUST fail closed before `fetch`, with an actionable broker configuration error that contains no secret value or secret path.
- `health` MUST inspect only local credential metadata; it MUST report `authenticated: false` and `externalCheckPerformed: false` until a later authenticated proof phase.
- Every CLI command MUST declare `@CommandAccess`, a typed `@Returns`, `--json`, and agent-usable help with official-source pointers.
- Read operations MUST use `youtube:read`; Analytics MUST use `youtube:analytics:read`; captions list/download MUST use `youtube:captions:read` because Google requires an elevated edit-capable scope.
- Public writes MUST use distinct comment/video/playlist write permissions and `risk: high` with confirmation. Video/playlist deletion and playlist-item removal MUST use distinct delete permissions and `risk: destructive` with confirmation.
- The app MUST declare no financial operations and MUST NOT request YouTube monetary/revenue Analytics metrics in Phase 1.
- The app MUST remain stateless: no SQLite schema, file persistence, migrations, or new NATS events.
- Channel uploads SHOULD be listed through `channels.list` -> uploads playlist -> `playlistItems.list` -> `videos.list`, avoiding the higher-cost legacy `search.list` listing path.
- Replies MUST use the official top-level comment resource ID (`topLevelComment.id`) as `comments.insert.snippet.parentId`, not the comment-thread ID.
- Partial video updates MUST preserve every mutable property in each included `part`; the command result MUST be refetched as a complete video representation after `videos.update`.
- Playlist reads MUST preserve each playlist-item ID independently, including duplicate videos and unavailable video resources, so destructive removal targets the selected occurrence.
- All tests MUST use injected credentials and fake `fetch`; no test may depend on network access or a real secret.

## Validation

- `bun test src/apps/youtube src/cli/commands/youtube.test.ts`
- `bun src/cli/index.ts apps check youtube --json`
- `bun src/cli/index.ts youtube health --json`
- `bun src/cli/index.ts apps run youtube health --json`
- `bun src/cli/index.ts yt health --json`
- `bun src/cli/index.ts yt info --json` with an isolated empty `RAVI_STATE_DIR` MUST fail before network access.
- `bun run gen:commands && bun run sdk:generate && bun run sdk:check`
- `bun run typecheck && bun run build`
- `bunx biome check src/apps/youtube src/cli/commands/youtube.ts src/cli/commands/youtube.test.ts`

## Known Failure Modes

- Reading `/home/ravi/sde/credentials/*` would silently couple the new app to the legacy deployment and violate credential isolation.
- Using `commentThread.id` as a reply parent can target the wrong resource; only `topLevelComment.id` is valid for `comments.insert`.
- Treating captions as generic read can understate the required `youtube.force-ssl`/`youtubepartner` authorization.
- Adding revenue metrics would introduce a financial permission class and the `yt-analytics-monetary.readonly` scope, which Phase 1 explicitly excludes.
- Running mutation commands for validation would create public or irreversible effects; only fake-fetch tests are valid in Phase 1.
- Treating `ravi yt` and `ravi youtube` as interchangeable public app routes
  bypasses the App Router on the static path and obscures which authorization
  boundary ran.
- Declaring `ravi youtube` as an operation command recursively re-enters the
  dynamic alias instead of launching the implementation CLI.

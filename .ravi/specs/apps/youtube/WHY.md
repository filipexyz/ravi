# YouTube Ravi App / WHY

## Rationale

`confirmed_official_contract: yes` on 2026-07-13.

The official Data API reference confirms the v3 resource model and relative endpoints under `https://www.googleapis.com/youtube/v3`. The official Analytics reference confirms `GET https://youtubeanalytics.googleapis.com/v2/reports`, its query parameters, and the required read scopes. This is sufficient to implement a native parallel app without treating SDE as the source of truth.

Official sources:

- Data API reference: <https://developers.google.com/youtube/v3/docs>
- OAuth scopes: <https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps>
- Analytics reports.query: <https://developers.google.com/youtube/analytics/reference/reports/query>
- Analytics channel reports: <https://developers.google.com/youtube/analytics/channel_reports>
- Captions download: <https://developers.google.com/youtube/v3/docs/captions/download>

The client is native rather than an SDE wrapper because the official REST contract is clear and bounded. It accepts an access-token envelope from the Ravi credential broker but does not implement token acquisition or refresh in Phase 1. This lets the structure, command contract, permissions and failure behavior be tested without a real credential.

## App Integration Contract

The manifest deliberately separates the public app name from its implementation
command:

- `ravi youtube ...` enters the generic App Router, applies app visibility and
  caller authorization, issues the child context, and resolves a declared
  operation;
- `ravi yt ...` is the registered static CLI that implements those operations;
- `ravi apps run youtube ...` is the explicit fallback and diagnostic entrypoint.

This preserves the existing decorated CLI and its generated SDK metadata
without making the SDK, UI, or tool surfaces independent executors. They are
clients of the same App Router operation.

The two permission declarations also have different jobs. Operation
`permissions` decide whether the caller may use or execute the YouTube app.
`context.allow` caps what the launched `ravi yt` process may do inside Ravi.
For the current implementation, `execute:group:yt` is the complete child
ceiling; expanding it requires an explicit manifest and security review.

`--json` remains an output option on `ravi yt`. It is useful to the router,
agents, and automation, but it is not a protocol between the app and Ravi.

## Legacy Gaps Corrected

- `sde yt videos` uses `search.list` for the upload feed. The native app follows Google's implementation guidance and reads the channel uploads playlist, reducing quota cost and preserving pagination.
- The legacy comment mapping exposes the thread ID as `commentId`. The official reply contract requires the top-level comment ID in `snippet.parentId`; the native app exposes both `threadId` and the correct `commentId`.
- Legacy `health` authenticates and calls Google. Native Phase 1 `health` checks broker metadata only and explicitly refuses to claim authentication.
- Legacy `auth-url` and `auth` are intentionally not migrated in this phase.

## Operation Matrix

| operacao_sde | categoria | risco_read_write | endpoint_ou_recurso_oficial | status_decisao | justificativa | fonte_oficial | observacoes_para_ravi_dev |
|---|---|---|---|---|---|---|---|
| `info` | channel | read | `GET /channels?mine=true` | migrar | Contract and channel statistics are official | channels.list | `youtube:read` |
| `videos` | videos | read | `GET /channels` + `GET /playlistItems` + `GET /videos` | migrar | Official uploads-playlist path is cheaper than legacy search | channels.list, playlistItems.list, videos.list | Cursor preserved |
| `video` | videos | read | `GET /videos?id=...` | migrar | Direct official detail lookup | videos.list | Normalized stable output |
| `buscar` | videos | read | `GET /search` + `GET /videos` | migrar | Official text/channel search, then enrichment | search.list, videos.list | Native name `search` |
| `stats` | videos | read | `GET /videos?id=...` + local derivation | migrar | Lifetime counters official; views/day deterministic | videos.list | No persistence |
| `comentarios` | comments | read | `GET /commentThreads?videoId=...` | migrar | Official thread listing | commentThreads.list | Exposes thread and comment IDs |
| `sem-resposta` | comments | read | `GET /commentThreads` + local filter | migrar | Reply count is in official thread resource | commentThreads.list | Native name `unanswered` |
| `responder` | comments | write-high | `POST /comments` | migrar | Official reply method | comments.insert | `youtube:comments:write`, HITL; fake-fetch only |
| `playlists` | playlists | read | `GET /playlists?mine=true` | migrar | Official owned-playlist list | playlists.list | `youtube:read` |
| `playlist` | playlists | read | `GET /playlistItems` + `GET /videos` | migrar | Official playlist contents | playlistItems.list, videos.list | Returns playlistItemId |
| `playlist-criar` | playlists | write-high | `POST /playlists` | migrar | Official create method | playlists.insert | `youtube:playlists:write`, HITL |
| `playlist-deletar` | playlists | destructive | `DELETE /playlists?id=...` | migrar | Official delete method | playlists.delete | `youtube:playlists:delete`, HITL |
| `playlist-add` | playlists | write-high | `POST /playlistItems` | migrar | Official item insertion | playlistItems.insert | Non-idempotent, HITL |
| `playlist-remove` | playlists | destructive | `DELETE /playlistItems?id=...` | migrar | Official item deletion | playlistItems.delete | Requires playlistItemId, HITL |
| `inscricoes` | subscriptions | read | `GET /subscriptions?mine=true` | migrar | Official outgoing subscription feed | subscriptions.list | Native name `subscriptions` |
| `legendas` | captions | read-sensitive | `GET /captions?videoId=...` | migrar | Official caption metadata | captions.list | Separate elevated permission |
| `legenda-baixar` | captions | read-sensitive | `GET /captions/{id}` | migrar | Official binary/text download | captions.download | Separate elevated permission |
| `categorias-video` | videos | read | `GET /videoCategories?regionCode=...` | migrar | Official assignable categories | videoCategories.list | Native name `video-categories` |
| `analytics-overview` | analytics | read | `GET /v2/reports` aggregate metrics | migrar | Official targeted query | reports.query, channel reports | No monetary metrics |
| `analytics-series` | analytics | read | `GET /v2/reports?dimensions=day` | migrar | Official time dimension | reports.query, channel reports | Metric allowlist |
| `analytics-top` | analytics | read | `GET /v2/reports?dimensions=video` + `GET /videos` | migrar | Official video report plus title enrichment | reports.query, videos.list | Bounded results |
| `analytics-traffic` | analytics | read | `GET /v2/reports?dimensions=insightTrafficSourceType` | migrar | Official traffic-source report | channel reports | No financial metrics |
| `analytics-demo` | analytics | read | `GET /v2/reports?dimensions=ageGroup,gender` | migrar | Official demographic report | channel reports | Native name `analytics-demographics` |
| `analytics-paises` | analytics | read | `GET /v2/reports?dimensions=country` | migrar | Official geography report | channel reports | Native name `analytics-countries` |
| `analytics-devices` | analytics | read | `GET /v2/reports?dimensions=deviceType` | migrar | Official device report | channel reports | `youtube:analytics:read` |
| `video-update` | videos | write-high | `GET /videos` + `PUT /videos` | migrar | Preserve unspecified required fields before official update | videos.list, videos.update | `youtube:videos:write`, HITL |
| `video-delete` | videos | destructive | `DELETE /videos?id=...` | migrar | Official permanent delete | videos.delete | `youtube:videos:delete`, HITL |
| `health` | setup | local-read | Ravi credential metadata only | adicionar | Phase 1 must not authenticate or call Google | Ravi broker contract | Reports no external proof |
| `auth-url`, `auth` | authentication | setup-sensitive | OAuth 2.0 flow | aguardar | Real auth/token onboarding is outside Phase 1 | OAuth guide | Not present in app/CLI |

Financial operations: none. Revenue and ad-performance reports are intentionally excluded.

## Rejected Alternatives

- **SDE wrapper:** rejected because it would retain legacy token-file coupling and duplicate-process behavior despite a clear official API.
- **Credential import from SDE:** rejected because Phase 1 forbids real token use and legacy secret access.
- **Database/cache:** rejected because all outputs are provider-owned data or deterministic derivations; persistence adds no lineage needed for Phase 1.
- **NATS events:** rejected because no new cross-system lifecycle is introduced.
- **Publish `ravi yt` as a second app path:** rejected because it bypasses the
  generic App Router and creates two authorization stories for one app.
- **Use SDK or tool operations as executors:** rejected because those surfaces
  can call the generic App Router and do not need another business
  implementation.

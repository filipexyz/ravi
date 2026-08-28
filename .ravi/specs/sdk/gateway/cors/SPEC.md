---
id: sdk/gateway/cors
title: "Gateway CORS"
kind: feature
domain: sdk
capability: gateway
feature: cors
capabilities:
  - gateway
  - cors
tags:
  - sdk
  - gateway
  - cors
  - flutter-web
applies_to:
  - src/sdk/gateway/cors.ts
  - src/sdk/gateway/server.ts
  - src/cli/commands/daemon.ts
  - packages/ravi-os-sdk/README.md
owners:
  - dev
status: active
normative: true
---

# Gateway CORS

## Intent

Flutter web and other browser clients call the HTTP-only SDK gateway from a
different origin than the daemon (for example `http://127.0.0.1:8088` →
`http://127.0.0.1:7777`). Desktop and mobile ignore CORS. Browsers do not.

The official Dart SDK sends `Authorization: Bearer rctx_*`, so
`Access-Control-Allow-Origin: *` is invalid. The gateway MUST echo the request
`Origin` only when that origin is explicitly allowed.

## Policy

- CORS MUST be closed by default. Production stays closed unless the operator
  sets an allowlist.
- `chrome-extension://` origins MUST remain allowed without env configuration.
- `RAVI_CORS_ORIGINS` MUST be an exact, comma-separated origin allowlist.
  The gateway MUST echo the request `Origin` only when it is on that list.
- `RAVI_CORS_LOCALHOST=1` MAY allow only `http://localhost:<port>` and
  `http://127.0.0.1:<port>`. It MUST be off by default. This is a dev-only
  flag, not a production default.
- The gateway MUST NOT emit `Access-Control-Allow-Origin: *`.
- The gateway MUST NOT reflect an arbitrary `Origin`.
- A `*` entry in `RAVI_CORS_ORIGINS` MUST be ignored.

## Preflight And Headers

- `OPTIONS` under `/api/v1/*` MUST return 204 with the same CORS header
  builder used by actual responses.
- Allowed methods MUST be `GET, POST, OPTIONS`.
- `Access-Control-Allow-Headers` MUST include `Authorization`,
  `Content-Type`, `x-ravi-sdk-version`, and `x-ravi-registry-hash`.
- SSE `GET /api/v1/_stream/*` MUST receive the same CORS headers via the
  shared `withCorsHeaders` wrapper. Do not add a second CORS path for streams.

## Non-Goals

- CORS does not grant authorization. Bearer `rctx_*` checks still apply.
- CORS does not change desktop or mobile clients.
- This feature does not generate or ship a Dart SDK.

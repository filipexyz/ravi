# Gateway CORS / CHECKS

## Checks

- `bun test src/sdk/gateway/cors.test.ts src/sdk/gateway/server.test.ts` MUST pass.
- `isAllowedOrigin` MUST allow `chrome-extension://` origins when env is empty; this check fails if those origins are rejected.
- `corsHeaders` MUST echo a listed `RAVI_CORS_ORIGINS` value on `Access-Control-Allow-Origin`; this check fails if a listed origin is omitted.
- `corsHeaders` MUST return no `Access-Control-Allow-Origin` for an unknown origin; this check fails if an unlisted origin is reflected.
- `corsHeaders` MUST never set `Access-Control-Allow-Origin` to `*`; this check fails if `*` is emitted for any origin or allowlist entry.
- `RAVI_CORS_LOCALHOST=1` MUST allow `http://127.0.0.1:8088` and `http://localhost:8088`; this check fails if those origins have no ACAO.
- `RAVI_CORS_LOCALHOST=1` MUST reject `https://evil.com` and lookalike hosts; this check fails if those origins receive ACAO.
- With no CORS env set, `http://127.0.0.1:8088` MUST stay closed; this check fails if production-default requests receive ACAO.
- OPTIONS preflight MUST include `Authorization`, `Content-Type`, `x-ravi-sdk-version`, and `x-ravi-registry-hash` in `Access-Control-Allow-Headers`; this check fails if any of the four is missing.
- SSE `GET /api/v1/_stream/*` MUST receive the same CORS headers via `withCorsHeaders`; this check fails if streams use a separate CORS path.

# Gateway CORS / CHECKS

## Checks

Run the CORS unit suite and the gateway HTTP wrapper tests:

```bash
bun test src/sdk/gateway/cors.test.ts src/sdk/gateway/server.test.ts
```

## Regression Scenarios

- `chrome-extension://` origins are still allowed with no env set.
- An origin listed in `RAVI_CORS_ORIGINS` is echoed on `Access-Control-Allow-Origin`.
- An unknown origin receives no `Access-Control-Allow-Origin`.
- `Access-Control-Allow-Origin` is never `*`, including when the allowlist contains `*`.
- `RAVI_CORS_LOCALHOST=1` allows `http://127.0.0.1:8088` and `http://localhost:8088`.
- `RAVI_CORS_LOCALHOST=1` does not allow `https://evil.com` or lookalike hosts.
- The localhost flag is off by default, so `http://127.0.0.1:8088` is closed in production.
- OPTIONS preflight `Access-Control-Allow-Headers` includes `Authorization`,
  `Content-Type`, `x-ravi-sdk-version`, and `x-ravi-registry-hash`.
- SSE `GET /api/v1/_stream/*` uses the same CORS wrapper as command POSTs.

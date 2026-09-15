# Gateway CORS / RUNBOOK

## Flutter web / local Chrome against a loopback gateway

The page origin and the gateway port are different, so the browser sends
CORS preflight. Enable one of:

```bash
# Exact allowlist (preferred)
RAVI_CORS_ORIGINS=http://127.0.0.1:8088

# Dev-only: any http://localhost:<port> or http://127.0.0.1:<port>
RAVI_CORS_LOCALHOST=1
```

Restart the daemon after changing `~/.ravi/.env`.

## Symptoms

- Browser console: CORS / missing `Access-Control-Allow-Origin`.
- OPTIONS to `/api/v1/...` returns 204 but no ACAO: origin is not allowed.
- ACAO is present but the request still fails: check that
  `Authorization`, `Content-Type`, `x-ravi-sdk-version`, and
  `x-ravi-registry-hash` are in `Access-Control-Allow-Headers`.

## Closed by default

If neither env is set, only `chrome-extension://` origins receive CORS
headers. Desktop and mobile SDKs are unaffected.

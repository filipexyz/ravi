# Devin Session API Adapter Runbook

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DEVIN_API_KEY` | Yes | Service-user key (`cog_` prefix) |
| `DEVIN_ORG_ID` | Yes | Organization ID (`org_` prefix) |
| `DEVIN_API_BASE_URL` | No | Default: `https://api.devin.ai/v3` |
| `DEVIN_DEFAULT_MAX_ACU_LIMIT` | No | Default ACU ceiling for sessions |
| `DEVIN_DEFAULT_MODE` | No | Default `devin_mode` (normal/fast/lite/ultra) |
| `DEVIN_DEFAULT_PLATFORM` | No | Default VM platform |
| `DEVIN_DEFAULT_REPOS` | No | Comma-separated default repo list |
| `DEVIN_DEFAULT_CREATE_AS_USER_ID` | No | Default impersonation user |
| `DEVIN_DEFAULT_TAGS` | No | Comma-separated default tags |

## Request Construction

The adapter uses `compactObject` to build request bodies:
- Undefined values are omitted (not sent as null)
- Empty arrays are omitted
- Only explicitly provided/configured fields appear in the payload

## Idempotent Creation

To create a session idempotently, pass `idempotencyKey` which maps to the
`devin_id` query parameter:

```typescript
client.createSession(input, { idempotencyKey: "devin-my-unique-id" });
```

## Error Handling

| HTTP Status | Error Code | Meaning |
|-------------|-----------|---------|
| 401 | `devin.auth.invalid` | Bad or expired API key |
| 403 | `devin.auth.forbidden` | Missing permission |
| 404 | `devin.not_found` | Session not found |
| 429 | `devin.rate_limited` | Too many requests |
| 400/422 | `devin.validation_failed` | Bad request body |
| 5xx | `devin.server_error` | Upstream failure |

## Testing Request Bodies

```bash
bun test src/devin/client.test.ts
```

Tests verify:
- Fields are only sent when explicit
- Auth token is in headers, not URL
- Compact body omits undefined fields
- Error mapping is correct for all status codes

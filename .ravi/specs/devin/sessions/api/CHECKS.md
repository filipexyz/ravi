# Devin Session API Adapter Checks

## Unit Tests

```bash
bun test src/devin/client.test.ts
```

Must verify:
- Request body includes only explicitly provided fields
- `devin_mode`, `platform`, `resumable`, `session_secrets`, `structured_output_required`
  are omitted when not set
- Idempotency key sent as query param, not body field
- Error mapping for 401/403/404/429/422/5xx
- Base URL normalization
- Auth header present, never in URL

## Integration Validation

```bash
ravi devin auth check --json
```

## Acceptance

- No field is sent to the API unless explicitly provided or configured
- Session secrets are never stored locally (write-only to API)
- All error responses produce typed `DevinApiError` with stable codes
- Backward compatibility: `advanced_mode` still accepted by the client
